'use client';
/**
 * W21b: pulling tip money out (W21a pays by pull, never by push).
 *
 * useHostTips: the stage host bar's "Claim host tips (X MON)". Reads hostClaimableOf when the
 * bar shows and again whenever a tip lands (one eth_call each), and claims through the host
 * route (the server's host key signs; lib/host/client.ts). Mock mode pulls it from the simulator.
 *
 * useTipShare: the phone's "You earned X MON from tips" after finalize. Reads claimableOf for
 * the player burner once the session is finalized and claims with the burner (like a hit).
 */
import { useCallback, useEffect, useState } from 'react';
import type { Address, Hash } from 'viem';
import { claimHostRequest } from '../host/client';
import type { SimSessionSummary } from '../mock/simulator';
import { agentAddress, getRuntime } from '../runtime';

export interface HostClaimOutcome {
  amountWei: bigint;
  txHash: Hash | null;
}

export interface UseHostTips {
  /** Unclaimed host share; null before the first read or when it failed. */
  claimableWei: bigint | null;
  busy: boolean;
  /** Claims with the stored host secret; resolves with what was paid. Rejects with the route's error. */
  claim(secret: string | null): Promise<HostClaimOutcome>;
}

/** `refreshKey` changes when a tip lands (the stage passes the live tip count). */
export function useHostTips(sessionId: bigint, enabled: boolean, refreshKey: number): UseHostTips {
  const [read, setRead] = useState<{ key: string; wei: bigint | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const key = `${sessionId}:${refreshKey}:${version}`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getRuntime()
      .readHostClaimable(sessionId)
      .then(
        (wei) => {
          if (!cancelled) setRead({ key, wei });
        },
        (error: unknown) => {
          console.warn(`host tips: hostClaimableOf(${sessionId}) failed: ${error instanceof Error ? error.message : String(error)}`);
          if (!cancelled) setRead({ key, wei: null });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled, key]);

  const claim = useCallback(
    async (secret: string | null): Promise<HostClaimOutcome> => {
      setBusy(true);
      try {
        const result = await claimHostRequest(secret, sessionId);
        // Mock mode: the route sends nothing; the share lives in this tab's simulator.
        const mock = result.txHash === null ? getRuntime().mockClaimHost(sessionId) : null;
        return { amountWei: mock ?? result.amountWei, txHash: result.txHash };
      } finally {
        setBusy(false);
        setVersion((v) => v + 1);
      }
    },
    [sessionId],
  );

  // Review: never show the previous figure while the read for a new tip is in flight.
  const current = read?.key === key ? read : null;
  return { claimableWei: enabled && current ? current.wei : null, busy, claim };
}

export type TipShareState =
  | { kind: 'idle' }
  | { kind: 'claiming' }
  | { kind: 'claimed'; amountWei: bigint; txHash: Hash | null }
  | { kind: 'failed'; message: string };

export interface UseTipShare {
  /** What claim() would pay now; null before the read (or before finalize). */
  claimableWei: bigint | null;
  state: TipShareState;
  claim(): Promise<void>;
}

export function useTipShare(sessionId: bigint, address: Address | null, finalized: boolean): UseTipShare {
  const [claimable, setClaimable] = useState<{ key: string; wei: bigint } | null>(null);
  const [state, setState] = useState<TipShareState>({ kind: 'idle' });
  const key = address && finalized ? `${sessionId}:${address}` : null;

  useEffect(() => {
    if (key === null || address === null) return;
    let cancelled = false;
    getRuntime()
      .readClaimable(sessionId, address)
      .then(
        (wei) => {
          if (!cancelled) setClaimable({ key, wei });
        },
        (error: unknown) => console.warn(`tip share: claimableOf failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    return () => {
      cancelled = true;
    };
  }, [sessionId, address, key]);

  const claim = useCallback(async (): Promise<void> => {
    setState({ kind: 'claiming' });
    try {
      const { amountWei, txHash } = await getRuntime().claimShare(sessionId);
      setState({ kind: 'claimed', amountWei, txHash });
      if (key !== null) setClaimable({ key, wei: 0n });
    } catch (error) {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, [sessionId, key]);

  return { claimableWei: key !== null && claimable?.key === key ? claimable.wei : null, state, claim };
}

/** Mock mode: the host route answered without a chain; tell this tab's simulator (and, over the bus, the phones). */
export function markMockFinalized(sessionId: bigint, tokenId: bigint): void {
  getRuntime().mockFinalize(sessionId, tokenId);
}

/** True when the page runs on the in-memory simulator (the tip page posts mock tip fields then). */
export function isMockRuntime(): boolean {
  return getRuntime().mode === 'mock';
}

export interface MockTrack {
  sessionId: bigint;
  summary: SimSessionSummary;
  hostClaimableWei: bigint;
  agent: Address | null;
}

/**
 * Mock mode's /track: the split lives in this tab's simulator (the stage tab navigates here
 * after minting). Re-read every second while open; null when the simulator never saw the token.
 */
export function useMockTrack(tokenId: bigint, intervalMs = 1_000): MockTrack | null {
  const [track, setTrack] = useState<MockTrack | null>(null);
  useEffect(() => {
    const read = (): void => {
      const sim = getRuntime().simulator;
      if (!sim) return;
      const sessionId = sim.sessionForToken(tokenId) ?? tokenId;
      const summary = sim.summary(sessionId);
      setTrack(summary ? { sessionId, summary, hostClaimableWei: sim.hostClaimableOf(sessionId), agent: agentAddress() } : null);
    };
    read();
    const timer = setInterval(read, intervalMs);
    return () => clearInterval(timer);
  }, [tokenId, intervalMs]);
  return track;
}
