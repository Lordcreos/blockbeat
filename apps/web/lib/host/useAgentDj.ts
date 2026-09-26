'use client';
/**
 * W12: the stage's DJ panel state. Polls /api/agent/status while `enabled` (the presenter
 * has a host secret stored: polling without one would pile up 401s and trip the auth
 * lockout) and starts/stops the agent child process on the laptop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HostClientError, agentStartRequest, agentStatusRequest, agentStopRequest, loadHostSecret, type AgentStatus } from './client';

export const AGENT_POLL_MS = 1_500;

export interface AgentDjError {
  code: string;
  status: number;
  message: string;
}

export interface UseAgentDjResult {
  status: AgentStatus | null;
  busy: boolean;
  error: AgentDjError | null;
  start(sessionId: bigint): Promise<void>;
  stop(): Promise<void>;
}

function toError(error: unknown): AgentDjError {
  if (error instanceof HostClientError) return { code: error.code, status: error.status, message: error.message };
  return { code: 'NETWORK', status: 0, message: error instanceof Error ? error.message : String(error) };
}

export function useAgentDj(enabled: boolean, pollMs: number = AGENT_POLL_MS): UseAgentDjResult {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  /** From start/stop; stays until the next action. */
  const [error, setError] = useState<AgentDjError | null>(null);
  /** From polling; cleared by the next successful poll. */
  const [pollError, setPollError] = useState<AgentDjError | null>(null);
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
        const next = await agentStatusRequest(loadHostSecret());
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

  const run = useCallback(async (action: () => Promise<AgentStatus>): Promise<void> => {
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

  const start = useCallback((sessionId: bigint) => run(() => agentStartRequest(loadHostSecret(), sessionId)), [run]);
  const stop = useCallback(() => run(() => agentStopRequest(loadHostSecret())), [run]);

  // Disabled (no secret, e.g. cleared after a 401): no verified status and no poll errors, but a
  // start/stop the presenter just pressed still reports why it failed.
  if (!enabled) return { status: null, busy, error, start, stop };
  return { status, busy, error: error ?? pollError, start, stop };
}
