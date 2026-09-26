'use client';
/**
 * W16: React glue for the playable phone. usePhoneClock is the only place the phone touches
 * the runtime's block clock (one newHeads subscription, free-running between heads);
 * useAimQueue owns one aim queue per clock and sender; usePhonePref keeps the player's mode
 * and preview choice in localStorage.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { stepForBlock } from '@blockbeat/shared';
import { isLocalNonceManager } from '@/lib/localNonce';
import { getRuntime } from '@/lib/runtime';
import { createAimQueue, type AimClock, type AimQueue, type AimQueueState, type AimRejection, type AimRequest, type AimSend, type AimItem, type AimResult } from './aimQueue';
import { aimClockFrom, createClockProxy } from './phoneClock';

/**
 * Starts the runtime block clock on the session start block and hands out a stable AimClock
 * view of it (no head until the effect has attached it). It does not re-render per block;
 * components that draw the playhead call useClockHead, so only they re-render ~3 times a second.
 */
export function usePhoneClock(startBlock: bigint | null): AimClock {
  const [proxy] = useState(createClockProxy);

  useEffect(() => {
    const { clock: runtimeClock } = getRuntime();
    runtimeClock.setStartBlock(startBlock);
    runtimeClock.start();
    const aim = aimClockFrom(runtimeClock);
    const detach = proxy.attach(aim);
    return () => {
      detach();
      aim.dispose();
    };
  }, [proxy, startBlock]);

  return proxy;
}

export interface ClockHead {
  /** Null until the first head. */
  head: bigint | null;
  /** The playhead step; null until the session start block is known. */
  step: number | null;
}

const noHead = (): null => null;
const noSubscribe = (): (() => void) => () => undefined;

export function useClockHead(clock: AimClock | null, startBlock: bigint | null): ClockHead {
  const head = useSyncExternalStore(clock ? clock.onBlock : noSubscribe, clock ? clock.head : noHead, noHead);
  return { head, step: head === null || startBlock === null ? null : stepForBlock(startBlock, head) };
}

const EMPTY: AimQueueState = { items: [], results: [], lead: 1, leadBlocks: 1 };

export interface UseAimQueueOptions {
  clock: AimClock | null;
  send: AimSend;
  startBlock: bigint | null;
  /** Notes the burner can still pay for (null = unknown). */
  budget: number | null;
  /** Called once per settled note (landed or failed), newest first, from the queue's own event. */
  onResult?: (result: AimResult) => void;
}

export interface UseAimQueue {
  state: AimQueueState;
  aim(request: AimRequest): { ok: true; item: AimItem } | { ok: false; reason: AimRejection };
  cancel(id: number): boolean;
  recordInclusion(sentAt: bigint | number, landedBlock: bigint): void;
}

export function useAimQueue({ clock, send, startBlock, budget, onResult }: UseAimQueueOptions): UseAimQueue {
  const [state, setState] = useState<AimQueueState>(EMPTY);
  const queue = useRef<AimQueue | null>(null);
  // Read on every aim, so a new balance or start block never recreates the queue (and drops its notes).
  const startRef = useRef(startBlock);
  const budgetRef = useRef(budget);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    startRef.current = startBlock;
    budgetRef.current = budget;
    onResultRef.current = onResult;
  }, [startBlock, budget, onResult]);

  useEffect(() => {
    if (!clock) return;
    const q = createAimQueue({ clock, send, startBlock: () => startRef.current, budget: () => budgetRef.current });
    queue.current = q;
    let lastResult: number | null = null;
    const off = q.subscribe((next) => {
      setState(next);
      const newest = next.results[0];
      if (newest && newest.id !== lastResult) {
        lastResult = newest.id;
        onResultRef.current?.(newest);
      }
    });
    setState(q.getState());
    // A nonce reset (send error, receipt timeout) changes the next send's path: re-time the waiting notes.
    const nonce = getRuntime().burner?.().account.nonceManager;
    const offNonce = isLocalNonceManager(nonce) ? nonce.onReset(() => q.retime()) : () => undefined;
    return () => {
      offNonce();
      off();
      q.dispose();
      if (queue.current === q) queue.current = null;
    };
  }, [clock, send]);

  const aim = useCallback<UseAimQueue['aim']>((request) => queue.current?.aim(request) ?? { ok: false, reason: 'no-clock' }, []);
  const cancel = useCallback((id: number) => queue.current?.cancel(id) ?? false, []);
  const recordInclusion = useCallback((sentAt: bigint | number, landed: bigint) => queue.current?.recordInclusion(sentAt, landed), []);
  return { state, aim, cancel, recordInclusion };
}

export const PREF_PREFIX = 'blockbeat:phone:';

/** A small persisted choice; defaults during SSR and hydration, then reads localStorage. */
export function usePhonePref<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  const key = PREF_PREFIX + name;
  const allowedRef = useRef(allowed);
  useEffect(() => {
    allowedRef.current = allowed;
  }, [allowed]);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(key);
    } catch (error) {
      console.warn(`phone pref ${name}: storage unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
    const match = allowedRef.current.find((a) => a === stored);
    if (match !== undefined) setValue(match);
  }, [key, name]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch (error) {
        console.warn(`phone pref ${name}: not saved (${error instanceof Error ? error.message : String(error)})`);
      }
    },
    [key, name],
  );
  return [value, set];
}

/** W16 follow-up: seen flags kept in memory when storage is unavailable, and who to tell when one changes. */
const memoryFlags = new Set<string>();
const flagListeners = new Set<() => void>();
const warnedFlags = new Set<string>();

function readFlag(key: string): boolean {
  if (memoryFlags.has(key)) return true;
  try {
    return window.localStorage.getItem(key) === 'done';
  } catch (error) {
    if (!warnedFlags.has(key)) {
      warnedFlags.add(key);
      console.warn(`phone flag ${key}: storage unavailable (${error instanceof Error ? error.message : String(error)}); kept in memory`);
    }
    return false;
  }
}

function subscribeFlags(cb: () => void): () => void {
  flagListeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    flagListeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

/**
 * A once-per-phone flag (the first-visit tour). `seen` is null during SSR and hydration, so a
 * first-time card never flashes for a returning player; then true or false from localStorage.
 */
export function useSeenFlag(name: string): { seen: boolean | null; markSeen(): void } {
  const key = PREF_PREFIX + name;
  const seen = useSyncExternalStore(subscribeFlags, () => readFlag(key), () => null);
  const markSeen = useCallback(() => {
    try {
      window.localStorage.setItem(key, 'done');
    } catch (error) {
      memoryFlags.add(key);
      console.warn(`phone flag ${key}: not saved (${error instanceof Error ? error.message : String(error)}); kept in memory`);
    }
    for (const cb of [...flagListeners]) cb();
  }, [key]);
  return { seen, markSeen };
}
