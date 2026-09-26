'use client';
/**
 * W19: the host bar's crowd state. Polls /api/crowd/status while `enabled` (a host secret is
 * stored; polling without one would pile up 401s and trip the auth lockout) and starts or stops
 * the simulated players on the laptop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HostClientError, loadHostSecret } from '../host/client';
import { crowdStartRequest, crowdStatusRequest, crowdStopRequest, type CrowdMode, type CrowdStatus } from './client';

export const CROWD_POLL_MS = 2_000;

export interface CrowdUiError {
  code: string;
  status: number;
  message: string;
}

export interface UseCrowdResult {
  status: CrowdStatus | null;
  busy: boolean;
  error: CrowdUiError | null;
  start(sessionId: bigint, mode: CrowdMode): Promise<void>;
  stop(): Promise<void>;
}

function toError(error: unknown): CrowdUiError {
  if (error instanceof HostClientError) return { code: error.code, status: error.status, message: error.message };
  return { code: 'NETWORK', status: 0, message: error instanceof Error ? error.message : String(error) };
}

export function useCrowd(enabled: boolean, pollMs: number = CROWD_POLL_MS): UseCrowdResult {
  const [status, setStatus] = useState<CrowdStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CrowdUiError | null>(null);
  const [pollError, setPollError] = useState<CrowdUiError | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      try {
        const next = await crowdStatusRequest(loadHostSecret());
        if (!cancelled) {
          setStatus(next);
          setPollError(null);
        }
      } catch (e) {
        if (!cancelled) setPollError(toError(e));
      }
      if (!cancelled) timer = setTimeout(() => void poll(), pollMs);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, pollMs]);

  const run = useCallback(async (action: () => Promise<CrowdStatus>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (mounted.current) setStatus(next);
    } catch (e) {
      if (mounted.current) setError(toError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const start = useCallback((sessionId: bigint, mode: CrowdMode) => run(() => crowdStartRequest(loadHostSecret(), { sessionId, mode })), [run]);
  const stop = useCallback(() => run(() => crowdStopRequest(loadHostSecret())), [run]);

  if (!enabled) return { status: null, busy, error, start, stop };
  return { status, busy, error: error ?? pollError, start, stop };
}
