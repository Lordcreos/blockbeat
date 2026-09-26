'use client';
/**
 * React hooks consumed by pages/components (W3). Signatures are the contract; the bodies
 * are backed by lib/runtime.ts, which picks the simulator (mock mode) or the chain.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { parseEther } from 'viem';
import { BLOCK_MS, DRIP_AMOUNT_MON, HIT_GAS_LIMIT, emptyPattern, type TrackId } from '@blockbeat/shared';
import type { BurnerAccount } from './burner';
import type { HistoryMode } from './eventFeed';
import { fundsLevel, notesLeft, type FundsLevel } from './funding';
import { HitError } from './hitSender';
import { FUNDS_SETTLE_MS, getRuntime, type AcquiredHitSender, type AcquiredTipSender } from './runtime';
import { TipError } from './tipSender';
import type { BlockClockState, BurnerWallet, DripResult, EventFeedState, HitEvent, HitReceipt, TipEvent, TipReceipt } from './types';

export function useBlockClock(startBlock: bigint | null): BlockClockState {
  const [state, setState] = useState<BlockClockState>(() => ({
    currentBlock: startBlock ?? 0n,
    currentStep: 0,
    measuredBlockMs: BLOCK_MS,
    msSinceHead: 0,
    source: 'mock',
  }));

  useEffect(() => {
    const { clock } = getRuntime();
    clock.setStartBlock(startBlock);
    clock.start();
    // The clock emits a step on lock and every block after; no synchronous read needed.
    const update = (): void => setState(clock.getState());
    const offStep = clock.onStep(update);
    const offHead = clock.onHead(update);
    return () => {
      offStep();
      offHead();
    };
  }, [startBlock]);

  return state;
}

const IDLE_FEED: EventFeedState = {
  pattern: emptyPattern(),
  session: null,
  hitCount: 0,
  uniquePlayers: 0,
  hitsPerMinute: 0,
  avgLatencyMs: null,
  connected: false,
  decodeErrors: 0,
  tipPoolWei: 0n,
  tipCount: 0,
  hits: [],
  historyReady: false,
  historyFrom: null,
  headHint: null,
};

interface LiveFeed {
  sessionId: bigint;
  state: EventFeedState;
  lastHit: HitEvent | null;
  /** W12: the most recent Tipped event seen live (null until one lands). */
  lastTip: TipEvent | null;
  error: string | null;
}

/** `history`: the stage asks for 'full' (W13); a phone keeps the default live window. */
export function useEventFeed(
  sessionId: bigint | null,
  history: HistoryMode = 'window',
): EventFeedState & { lastHit: HitEvent | null; lastTip: TipEvent | null; error: string | null } {
  const [live, setLive] = useState<LiveFeed | null>(null);

  useEffect(() => {
    if (sessionId === null) return;
    const { feed, release } = getRuntime().acquireFeed(sessionId, { history });
    let cancelled = false;
    const patch = (p: Partial<Omit<LiveFeed, 'sessionId'>>): void => {
      if (cancelled) return; // a late result for a previous session id must not clobber the current one
      setLive((prev) => {
        const base = prev && prev.sessionId === sessionId ? prev : { sessionId, state: feed.getState(), lastHit: null, lastTip: null, error: null };
        return { ...base, ...p };
      });
    };
    const offChange = feed.onChange((state) => patch({ state }));
    const offHit = feed.onHit((lastHit) => patch({ lastHit }));
    const offTip = feed.onTip((lastTip) => patch({ lastTip }));
    feed.start().then(
      () => patch({ state: feed.getState(), error: null }),
      (e: unknown) => patch({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
      offChange();
      offHit();
      offTip();
      release();
    };
  }, [sessionId, history]);

  if (sessionId === null || live === null || live.sessionId !== sessionId) {
    return { ...IDLE_FEED, lastHit: null, lastTip: null, error: null };
  }
  return { ...live.state, lastHit: live.lastHit, lastTip: live.lastTip, error: live.error };
}

const walletViews = new WeakMap<BurnerAccount, BurnerWallet>();

/** Stable `{ address, restored }` view of the burner; the account object never reaches the UI. */
function burnerView(): BurnerWallet {
  const account = getRuntime().burner();
  let view = walletViews.get(account);
  if (!view) {
    view = { address: account.address, restored: account.restored, persisted: account.persisted };
    walletViews.set(account, view);
  }
  return view;
}

const noopSubscribe = (): (() => void) => () => undefined;
const nullSnapshot = (): null => null;

export function useBurner(): BurnerWallet | null {
  // The burner lives in localStorage: null on the server and during hydration, then stable.
  return useSyncExternalStore(noopSubscribe, burnerView, nullSnapshot);
}

interface DripErrorBody {
  error?: { code?: string; message?: string };
}

interface DripOutcome {
  address: `0x${string}`;
  drip: DripResult | null;
  error: string | null;
  /** W19: the drip refused a new player (DRIP_MAX_PLAYERS_PER_SESSION). */
  roomFull: boolean;
}

function isDripResult(body: unknown): body is DripResult {
  return typeof body === 'object' && body !== null && 'track' in body && 'alreadyFunded' in body;
}

/** Review C4 (client side): a 429 is retried by itself after Retry-After, at most this many POSTs per address. */
export const MAX_DRIP_ATTEMPTS = 6;
const DEFAULT_RETRY_AFTER_S = 5;
const MAX_RETRY_AFTER_S = 60;
/**
 * W12: after the drip answers with a hash, inclusion (about two blocks) plus FUNDS_SETTLE_MS
 * until the burner can spend it: the length of the "Funding your wallet · N s" countdown.
 */
export const FUNDING_SETTLE_ESTIMATE_MS = FUNDS_SETTLE_MS + 2 * BLOCK_MS;

/** W12: where a drip or top-up is, for the phone's countdown line. */
export type FundingPhase =
  | { kind: 'requesting' }
  | { kind: 'retrying'; seconds: number }
  | { kind: 'settling'; until: number };

function retryAfterSeconds(res: Response): number {
  const raw = res.headers.get('retry-after')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_RETRY_AFTER_S;
  return Math.min(MAX_RETRY_AFTER_S, Number(raw));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface DripPost {
  res: Response;
  body: unknown;
}

/**
 * POSTs to /api/drip, waiting out a 429's Retry-After with a per-second callback (null when
 * the wait is over), at most MAX_DRIP_ATTEMPTS times. Shared by the first drip and top-ups.
 */
async function postDrip(payload: { address: `0x${string}`; topUp?: true; sessionId?: string }, onRetry: (seconds: number | null) => void, cancelled: () => boolean): Promise<DripPost> {
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    res = await fetch('/api/drip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status !== 429 || attempt >= MAX_DRIP_ATTEMPTS || cancelled()) break;
    // Rate limited: wait what the server asked for, counting down, then ask again.
    for (let left = Math.max(1, retryAfterSeconds(res)); left > 0 && !cancelled(); left--) {
      onRetry(left);
      await sleep(1_000);
    }
    onRetry(null);
  }
  return { res, body: (await res.json()) as unknown };
}

function dripErrorOf(post: DripPost): { code: string; message: string } {
  const err = (post.body as DripErrorBody | null)?.error;
  return { code: err?.code ?? `HTTP_${post.res.status}`, message: err?.message ?? 'drip failed' };
}

export interface UseDripResult {
  drip: DripResult | null;
  loading: boolean;
  error: string | null;
  /** Seconds until the next automatic retry after a 429; null when no retry is pending. */
  retryInSeconds: number | null;
  /** W12: requesting, retrying after a 429, or settling (with a deadline); null once done. */
  phase: FundingPhase | null;
  /** W19: the room is full (the drip's per-session player cap); the phone only watches. */
  roomFull: boolean;
}

/** W19: `sessionId` lets the drip apply its per-session player cap (ROOM_FULL). */
export function useDrip(address: `0x${string}` | null, sessionId: bigint | null = null): UseDripResult {
  const session = sessionId === null ? null : sessionId.toString();
  const [outcome, setOutcome] = useState<DripOutcome | null>(null);
  const [phase, setPhase] = useState<{ address: `0x${string}`; phase: FundingPhase } | null>(null);

  useEffect(() => {
    if (address === null) return;
    let cancelled = false;
    const show = (p: FundingPhase): void => {
      if (!cancelled) setPhase({ address, phase: p });
    };
    (async () => {
      let next: DripOutcome;
      show({ kind: 'requesting' });
      try {
        const post = await postDrip(
          session === null ? { address } : { address, sessionId: session },
          (seconds) => show(seconds === null ? { kind: 'requesting' } : { kind: 'retrying', seconds }),
          () => cancelled,
        );
        const { res, body } = post;
        if (res.ok && isDripResult(body)) {
          // Mock mode: no chain, so the simulator holds the drip (W12: the balance pill works offline).
          if (body.txHash === null && !body.alreadyFunded) getRuntime().creditDrip(address, parseEther(DRIP_AMOUNT_MON));
          // The route answers with the hash (review C3); wait here, from the phone's own IP,
          // until the balance is spendable so the first tap never fails on an empty wallet.
          if (body.txHash !== null && !body.alreadyFunded) {
            show({ kind: 'settling', until: Date.now() + FUNDING_SETTLE_ESTIMATE_MS });
            try {
              const funded = await getRuntime().waitForFunds(address);
              if (!funded) console.warn(`drip ${body.txHash}: balance still zero after the wait; enabling pads anyway`);
            } catch (e) {
              console.warn(`drip ${body.txHash}: balance check failed (${e instanceof Error ? e.message : String(e)}); enabling pads anyway`);
            }
          }
          next = { address, drip: body, error: null, roomFull: false };
        } else {
          const err = dripErrorOf(post);
          next = { address, drip: null, error: `${err.code}: ${err.message}`, roomFull: err.code === 'ROOM_FULL' };
        }
      } catch (e) {
        next = { address, drip: null, error: e instanceof Error ? e.message : String(e), roomFull: false };
      }
      if (!cancelled) {
        setPhase(null);
        setOutcome(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, session]);

  if (address === null) return { drip: null, loading: false, error: null, retryInSeconds: null, phase: null, roomFull: false };
  if (outcome === null || outcome.address !== address) {
    const current = phase && phase.address === address ? phase.phase : { kind: 'requesting' as const };
    return { drip: null, loading: true, error: null, retryInSeconds: current.kind === 'retrying' ? current.seconds : null, phase: current, roomFull: false };
  }
  return { drip: outcome.drip, loading: false, error: outcome.error, retryInSeconds: null, phase: null, roomFull: outcome.roomFull };
}

export interface UseTopUpResult {
  /** Asks the drip for a top-up and waits until the balance rose; resolves false on a refusal or failure. */
  topUp(): Promise<boolean>;
  /** Same countdown phases as the first drip; null when idle. */
  phase: FundingPhase | null;
  error: { code: string; message: string } | null;
  /** From the last successful top-up; null before one. */
  topUpsLeft: number | null;
}

/**
 * W12: `POST /api/drip { address, topUp: true }` from the almost-out state. The server
 * decides (funded before, under 0.03 MON, at most two); the phone shows the same countdown
 * as the first drip and waits until the balance is above what it was before.
 */
export function useTopUp(address: `0x${string}` | null): UseTopUpResult {
  const [phase, setPhase] = useState<FundingPhase | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [topUpsLeft, setTopUpsLeft] = useState<number | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const topUp = useCallback(async (): Promise<boolean> => {
    if (address === null || busy.current) return false;
    busy.current = true;
    const show = (p: FundingPhase | null): void => {
      if (mounted.current) setPhase(p);
    };
    show({ kind: 'requesting' });
    setError(null);
    try {
      const runtime = getRuntime();
      let before: bigint | null = null;
      try {
        before = await runtime.readBalance(address);
      } catch (e) {
        console.warn(`top-up: balance read before the top-up failed (${e instanceof Error ? e.message : String(e)}); waiting for any balance`);
      }
      const post = await postDrip(
        { address, topUp: true },
        (seconds) => show(seconds === null ? { kind: 'requesting' } : { kind: 'retrying', seconds }),
        () => !mounted.current,
      );
      const { res, body } = post;
      if (!res.ok || !isDripResult(body)) {
        if (mounted.current) setError(dripErrorOf(post));
        return false;
      }
      if (body.txHash === null) {
        runtime.creditDrip(address, parseEther(DRIP_AMOUNT_MON));
      } else {
        show({ kind: 'settling', until: Date.now() + FUNDING_SETTLE_ESTIMATE_MS });
        try {
          const risen = await runtime.waitForFunds(address, { above: before ?? 0n });
          if (!risen) console.warn(`top-up ${body.txHash}: balance did not rise within the wait`);
        } catch (e) {
          console.warn(`top-up ${body.txHash}: balance check failed (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      if (mounted.current) setTopUpsLeft(body.topUpsLeft ?? null);
      return true;
    } catch (e) {
      if (mounted.current) setError({ code: 'NETWORK', message: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      busy.current = false;
      show(null);
    }
  }, [address]);

  return { topUp, phase, error, topUpsLeft };
}

export interface UseBalanceResult {
  /** Last balance read from this device; null before the first read (or for an unfunded mock wallet). */
  balanceWei: bigint | null;
  /** Notes that balance still buys at the burner's current gas tier. */
  notesLeft: number | null;
  level: FundsLevel | null;
  /** Last read failure; the previous balance stays on screen. */
  error: string | null;
  /** Read again (after a landed hit, a tip or a top-up). */
  refresh(): void;
}

interface BalanceRead {
  key: string;
  balanceWei: bigint | null;
  notesLeft: number | null;
  error: string | null;
}

/**
 * W12: the burner's MON balance and how many notes it still buys, read once when enabled and
 * again on every `refresh()`. No polling: 60 phones share the public RPC, so the page asks
 * after each landed hit or tip instead.
 */
export function useBalance(address: `0x${string}` | null, sessionId: bigint | null, enabled: boolean, landedInSession = false): UseBalanceResult {
  const [version, setVersion] = useState(0);
  const [read, setRead] = useState<BalanceRead | null>(null);
  const key = address && sessionId !== null ? `${address}:${sessionId}` : null;

  useEffect(() => {
    if (!enabled || address === null || sessionId === null || key === null) return;
    let cancelled = false;
    const runtime = getRuntime();
    runtime.readBalance(address).then(
      (balanceWei) => {
        if (cancelled) return;
        // A landed note means the next one is on the lower tier, even if the receipt that flips
        // the gas flag has not been seen yet (the read races it).
        const nextGas = landedInSession ? HIT_GAS_LIMIT : runtime.hitGasFor(sessionId);
        const notes = balanceWei === null ? null : notesLeft(balanceWei, nextGas);
        setRead({ key, balanceWei, notesLeft: notes, error: null });
      },
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`balance: read for ${address} failed (${message}); keeping the last value`);
        if (cancelled) return;
        setRead((prev) => (prev && prev.key === key ? { ...prev, error: message } : { key, balanceWei: null, notesLeft: null, error: message }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [address, sessionId, key, enabled, version, landedInSession]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const current = read && read.key === key ? read : null;
  return {
    balanceWei: current?.balanceWei ?? null,
    notesLeft: current?.notesLeft ?? null,
    level: current?.notesLeft === null || current?.notesLeft === undefined ? null : fundsLevel(current.notesLeft),
    error: current?.error ?? null,
    refresh,
  };
}

export function useHitSender(sessionId: bigint | null): {
  send: (track: TrackId, note: number) => Promise<HitReceipt>;
  pending: number;
} {
  const [pending, setPending] = useState(0);
  const held = useRef<AcquiredHitSender | null>(null);

  useEffect(() => {
    if (sessionId === null) return;
    const acquired = getRuntime().acquireHitSender(sessionId);
    held.current = acquired;
    return () => {
      if (held.current === acquired) held.current = null;
      acquired.release();
    };
  }, [sessionId]);

  const send = useCallback(
    async (track: TrackId, note: number): Promise<HitReceipt> => {
      if (sessionId === null) throw new HitError('INVALID_ARGS', 'no session selected');
      // Normally the effect above holds the sender; before it runs, hold one for this call only.
      const transient = held.current ? null : getRuntime().acquireHitSender(sessionId);
      const sender = (held.current ?? transient)?.sender;
      if (!sender) throw new HitError('SEND_FAILED', 'hit sender unavailable');
      const p = sender.send(sessionId, track, note);
      setPending(sender.pending());
      try {
        return await p;
      } finally {
        setPending(sender.pending());
        transient?.release();
      }
    },
    [sessionId],
  );

  return { send, pending };
}

export function useTip(sessionId: bigint | null): {
  tip: () => Promise<TipReceipt>;
  pending: boolean;
  /** W12: when a tip can go out under the reserve rule (for the countdown); null when it can go now. */
  readyAt: () => number | null;
} {
  const [pending, setPending] = useState(false);
  const held = useRef<AcquiredTipSender | null>(null);

  useEffect(() => {
    if (sessionId === null) return;
    const acquired = getRuntime().acquireTipSender(sessionId);
    held.current = acquired;
    return () => {
      if (held.current === acquired) held.current = null;
      acquired.release();
    };
  }, [sessionId]);

  const tip = useCallback(async (): Promise<TipReceipt> => {
    if (sessionId === null) throw new TipError('INVALID_ARGS', 'no session selected');
    // Normally the effect above holds the sender; before it runs, hold one for this call only.
    const transient = held.current ? null : getRuntime().acquireTipSender(sessionId);
    const sender = (held.current ?? transient)?.sender;
    if (!sender) throw new TipError('SEND_FAILED', 'tip sender unavailable');
    const p = sender.send(sessionId);
    setPending(sender.pending() > 0);
    try {
      return await p;
    } finally {
      setPending(sender.pending() > 0);
      transient?.release();
    }
  }, [sessionId]);

  const readyAt = useCallback((): number | null => getRuntime().tipReadyAt(), []);

  return { tip, pending, readyAt };
}
