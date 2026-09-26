/**
 * Event feed: the live view of one session.
 *
 * On start it reads `pattern(sessionId)` and `getSession(sessionId)`, then watches `Hit`
 * logs. The chain-backed source subscribes over WebSocket first and the feed falls back to
 * HTTP polling (400 ms) when the socket errors. Every hit is applied to the pattern,
 * de-duplicated by (txHash, logIndex), and folded into the HUD counters.
 *
 * Review H2 / L4: a poll filter starts at "now", so hits that landed while the socket was
 * down would be missing for the rest of the set. On every watch-mode switch, and every
 * 10 s while polling, the feed re-reads pattern and session and replaces its state; while
 * polling it retries the socket every 30 s.
 *
 * W13: the feed also keeps the session's Hit history, the input of the live (decaying) layer.
 * After start it backfills with getLogs in HISTORY_CHUNK_BLOCKS chunks, newest first, only the
 * live replay window (2 lifetimes + fade + overlap = 304 blocks at 8 bars): nothing older can
 * change what plays, and an old session must not cost a minute of getLogs (coordinator, W13).
 * 'full' mode, which walks back to the session start, stays available but nothing uses it.
 * Phones also filter by their own address (60 phones share the public RPC). Backfilled hits only enter
 * the history: they never bump hitCount or fire onHit, because the hit sender resolves taps
 * from onHit and the live stream keeps its own dedupe. Every resync reads the gap since the
 * last scanned block again, overlapping RESYNC_OVERLAP_BLOCKS so a lagging RPC node cannot
 * leave a hole (the txHash:logIndex dedupe makes the overlap free).
 */
import { parseEther, type Address } from 'viem';
import {
  NOTE_LIFETIME_BARS,
  applyHit,
  compareHits,
  emptyPattern,
  replayFromBlock,
  type HitEvent,
  type Pattern,
  type SessionState,
  type TipSplitEvent,
} from '@blockbeat/shared';
import { HitDecodeError } from './chain/eventSource';
import { sharedLatency, type LatencyTracker } from './latency';
import { TIP_AMOUNT_MON } from './tipSender';
import type { EventFeed, EventFeedState, TipEvent } from './types';

/** Every tip the app sends is this size, so the pool at load says how many tips it holds (no indexer). */
const APP_TIP_WEI = parseEther(TIP_AMOUNT_MON);

export type HitWatchMode = 'ws' | 'poll';

export interface HitWatchArgs {
  sessionId: bigint;
  mode: HitWatchMode;
  pollingIntervalMs?: number;
  onHits(hits: HitEvent[]): void;
  onError(error: Error): void;
}

export interface TipWatchArgs {
  sessionId: bigint;
  mode: HitWatchMode;
  pollingIntervalMs?: number;
  onTips(tips: TipEvent[]): void;
  onError(error: Error): void;
}

/** W13: one getLogs range of Hit events (inclusive bounds), optionally for one player. */
export interface HitRangeQuery {
  sessionId: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  player?: Address;
}

export interface HitRange {
  hits: HitEvent[];
  /** Logs in the range that could not be decoded (dropped and counted, like the live stream's). */
  decodeErrors: number;
}

/** Where hits and session state come from: the chain (lib/chain) or the simulator. */
export interface EventSource {
  readPattern(sessionId: bigint): Promise<Pattern>;
  readSession(sessionId: bigint): Promise<SessionState | null>;
  watchHits(args: HitWatchArgs): () => void;
  /** W12: Tipped logs of the session; optional so a source without tips still works. */
  watchTips?(args: TipWatchArgs): () => void;
  /** W13: Hit logs in a block range (getLogs); without it the history is the live stream only. */
  readHits?(query: HitRangeQuery): Promise<HitRange>;
  /** W13: the latest block number, the top of every backfill. */
  readHead?(): Promise<bigint>;
  /** W21b: `totalTipsOf(sessionId)` (W21a): every wei tipped, host share and players' pool. */
  readTotalTips?(sessionId: bigint): Promise<bigint>;
  /** W21b: `TipSplit` logs (W21a), emitted right after every `Tipped`: how much went to the pool. */
  watchTipSplits?(args: TipSplitWatchArgs): () => void;
  /**
   * W21b: pushes the session when it changes out of band (the simulator's mock finalize, heard
   * over the bus). The chain source has none: a phone sees finalize at its next session read.
   */
  watchSession?(args: { sessionId: bigint; onSession(session: SessionState): void }): () => void;
}

export interface TipSplitWatchArgs {
  sessionId: bigint;
  mode: HitWatchMode;
  pollingIntervalMs?: number;
  onSplits(splits: TipSplitEvent[]): void;
  onError(error: Error): void;
}

/** W13: how much Hit history the feed reads back: the live window, or the whole session. */
export type HistoryMode = 'window' | 'full' | 'none';

export interface EventFeedOptions {
  sessionId: bigint;
  source: EventSource;
  /** Polling cadence used after the socket fails. */
  pollingIntervalMs?: number;
  /** While polling: how often pattern and session are re-read from the chain. */
  resyncIntervalMs?: number;
  /** While polling: how often the socket subscription is attempted again. */
  wsRetryIntervalMs?: number;
  now?: () => number;
  latency?: LatencyTracker;
  /** W13: 'window' (default) reads back the live window only; 'full' reads the whole session. */
  history?: HistoryMode;
  /** W13: only this player's hits are read back (the phone's own notes). */
  historyPlayer?: Address;
  /** W13: note lifetime in bars; 0 turns decay off and with it the backfill. Default 8. */
  lifetimeBars?: number;
  /**
   * W21b: read `totalTipsOf` with the session and watch `TipSplit` (the stage and the tip page).
   * Off by default: 60 phones need neither, and every watch costs the public RPC in poll mode.
   */
  tipTotals?: boolean;
  /**
   * W13: wait this long before the first history read. Phones pass a random 0-1.5 s so a room
   * that scans the QR together does not hit the public RPC in the same second (TS review H1).
   */
  initialSyncDelayMs?: number;
}

export interface EventFeedController extends EventFeed {
  onError(cb: (error: Error) => void): () => void;
  /** W13: switch a 'window' feed to 'full' history (the stage after a phone feed was shared). */
  requestFullHistory(): void;
}

const HPM_WINDOW_MS = 60_000;
/** W21b: live tips kept for the stage's list (newest last). */
export const LIVE_TIPS_LIMIT = 50;
const SEEN_LIMIT = 4096;
export const RESYNC_INTERVAL_MS = 10_000;
export const WS_RETRY_INTERVAL_MS = 30_000;
/** W13: blocks per eth_getLogs call; the agent uses the same range against the public RPC. */
export const HISTORY_CHUNK_BLOCKS = 100;
/** W13: every catch-up re-reads this many blocks below the last scanned one (a lagging node may have missed them). */
export const RESYNC_OVERLAP_BLOCKS = 16;

export function createEventFeed(options: EventFeedOptions): EventFeedController {
  const { sessionId, source } = options;
  const pollingIntervalMs = options.pollingIntervalMs ?? 400;
  const resyncIntervalMs = options.resyncIntervalMs ?? RESYNC_INTERVAL_MS;
  const wsRetryIntervalMs = options.wsRetryIntervalMs ?? WS_RETRY_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const latency = options.latency ?? sharedLatency;
  const lifetimeBars = options.lifetimeBars ?? NOTE_LIFETIME_BARS;
  const historyPlayer = options.historyPlayer;
  const readHits = source.readHits?.bind(source);
  const readHead = source.readHead?.bind(source);
  const tipTotals = options.tipTotals ?? false;
  const readTotalTips = tipTotals ? source.readTotalTips?.bind(source) : undefined;
  // W21b: 'none' (the tip page) never backfills; it only needs the session and the live streams.
  const historyEnabled = options.history !== 'none' && lifetimeBars > 0 && readHits !== undefined && readHead !== undefined;
  /**
   * Lowest block the live layer can need at `head` (the shared replay window: 2 lifetimes + the
   * fade, so voice-cap evictions come out the same on every device), minus the overlap.
   */
  const windowFloor = (head: bigint): bigint => replayFromBlock(head, Math.max(1, lifetimeBars)) - BigInt(RESYNC_OVERLAP_BLOCKS);
  let wantFull = options.history === 'full';

  let pattern: Pattern = emptyPattern();
  let session: SessionState | null = null;
  let hitCount = 0;
  let connected = false;
  let decodeErrors = 0;
  const players = new Set<string>();
  const hitTimes: number[] = [];
  const seen = new Set<string>();
  let tipPoolWei = 0n;
  /** W21b: every tip's full amount (pool + host share): the "Raised" figure. */
  let raisedWei = 0n;
  let liveTips: readonly TipEvent[] = [];
  const seenSplits = new Set<string>();
  /** Tips implied by the pool at the first read, and Tipped events seen since. */
  let tipsAtLoad: number | null = null;
  let tipsLive = 0;
  const seenTips = new Set<string>();
  /** W13: every known hit by txHash:logIndex, and the same hits sorted by (blockNumber, logIndex). */
  const history = new Map<string, HitEvent>();
  let sortedHits: readonly HitEvent[] = [];
  /** Top of the contiguous range the backfill has read; null until the live window is in. */
  let scannedTo: bigint | null = null;
  let historyFrom: bigint | null = null;
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  let headHint: { block: bigint; atMs: number } | null = null;
  let initialSyncTimer: ReturnType<typeof setTimeout> | null = null;

  function seeBlock(block: bigint): void {
    if (headHint === null || block > headHint.block) headHint = { block, atMs: now() };
  }

  let unwatch: (() => void) | null = null;
  let unwatchTips: (() => void) | null = null;
  let unwatchSplits: (() => void) | null = null;
  let unwatchSession: (() => void) | null = null;
  let unsubscribeLatency: (() => void) | null = null;
  let running = false;
  let starting: Promise<void> | null = null;
  let mode: HitWatchMode = 'ws';
  let resyncTimer: ReturnType<typeof setInterval> | null = null;
  let wsRetryTimer: ReturnType<typeof setTimeout> | null = null;

  const hitListeners = new Set<(hit: HitEvent) => void>();
  const changeListeners = new Set<(state: EventFeedState) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const tipListeners = new Set<(tip: TipEvent) => void>();

  function tipCount(): number {
    return Math.max(Number(tipPoolWei / APP_TIP_WEI), (tipsAtLoad ?? 0) + tipsLive);
  }

  function hitsPerMinute(): number {
    const cutoff = now() - HPM_WINDOW_MS;
    while (hitTimes.length > 0 && (hitTimes[0] ?? 0) <= cutoff) hitTimes.shift();
    return hitTimes.length;
  }

  function getState(): EventFeedState {
    return {
      pattern,
      session,
      hitCount,
      uniquePlayers: players.size,
      hitsPerMinute: hitsPerMinute(),
      avgLatencyMs: latency.average(),
      connected,
      decodeErrors,
      tipPoolWei,
      tipCount: tipCount(),
      raisedWei,
      tips: liveTips,
      hits: sortedHits,
      historyReady: !historyEnabled || scannedTo !== null,
      historyFrom,
      headHint,
    };
  }

  /** Adds hits the history does not hold yet; returns true when it changed. */
  function remember(hits: readonly HitEvent[]): boolean {
    const fresh: HitEvent[] = [];
    for (const hit of hits) {
      const key = `${hit.txHash}:${hit.logIndex}`;
      if (history.has(key)) continue;
      history.set(key, hit);
      fresh.push(hit);
    }
    if (fresh.length === 0) return false;
    fresh.sort(compareHits);
    sortedHits = mergeSorted(sortedHits, fresh);
    return true;
  }

  function emitChange(): void {
    const s = getState();
    for (const cb of changeListeners) cb(s);
  }

  function emitError(error: Error): void {
    for (const cb of errorListeners) cb(error);
  }

  function onHits(hits: HitEvent[]): void {
    let changed = false;
    for (const hit of hits) {
      const key = `${hit.txHash}:${hit.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > SEEN_LIMIT) {
        const first = seen.values().next().value;
        if (first !== undefined) seen.delete(first);
      }
      pattern = applyHit(pattern, hit);
      remember([hit]);
      seeBlock(hit.blockNumber);
      hitCount += 1;
      players.add(hit.player.toLowerCase());
      hitTimes.push(now());
      changed = true;
      for (const cb of hitListeners) cb(hit);
    }
    if (changed) emitChange();
  }

  function onTips(tips: TipEvent[]): void {
    let changed = false;
    for (const tip of tips) {
      const key = `${tip.txHash}:${tip.logIndex}`;
      if (seenTips.has(key)) continue;
      seenTips.add(key);
      if (seenTips.size > SEEN_LIMIT) {
        const first = seenTips.values().next().value;
        if (first !== undefined) seenTips.delete(first);
      }
      // W21a: only the players' 80 % reaches the pool. The simulator hands the split with the tip;
      // on chain it arrives as a TipSplit log (onSplits) or with the next session read.
      if (tip.split) tipPoolWei += tip.split.poolWei;
      raisedWei += tip.amountWei;
      liveTips = [...liveTips, tip].slice(-LIVE_TIPS_LIMIT);
      tipsLive += 1;
      if (session) session = { ...session, tipPool: tipPoolWei };
      changed = true;
      for (const cb of tipListeners) cb(tip);
    }
    if (changed) emitChange();
  }

  /** W21b: the pool part of chain tips, from their TipSplit logs; attached to the live tip too. */
  function onSplits(splits: TipSplitEvent[]): void {
    let changed = false;
    for (const split of splits) {
      const key = `${split.txHash}:${split.logIndex}`;
      if (seenSplits.has(key)) continue;
      seenSplits.add(key);
      if (seenSplits.size > SEEN_LIMIT) {
        const first = seenSplits.values().next().value;
        if (first !== undefined) seenSplits.delete(first);
      }
      tipPoolWei += split.poolAmount;
      if (session) session = { ...session, tipPool: tipPoolWei };
      const hash = split.txHash.toLowerCase();
      liveTips = liveTips.map((t) => (t.txHash.toLowerCase() === hash && !t.split ? { ...t, split: { hostWei: split.hostAmount, poolWei: split.poolAmount } } : t));
      changed = true;
    }
    if (changed) emitChange();
  }

  async function readChain(): Promise<void> {
    const [p, s, totalTips] = await Promise.all([
      source.readPattern(sessionId),
      source.readSession(sessionId),
      readTotalTips ? readTotalTips(sessionId) : Promise.resolve(null),
    ]);
    if (!running) return; // stopped while reading
    pattern = [...p];
    session = s;
    hitCount = s ? Number(s.hitCount) : 0;
    tipPoolWei = s?.tipPool ?? 0n;
    // Without totalTipsOf (phones) the pool is the best figure at hand; the stage reads the total.
    raisedWei = totalTips ?? tipPoolWei;
    tipsAtLoad ??= Number(tipPoolWei / APP_TIP_WEI) - tipsLive;
  }

  /** Reads [bottom, top] newest chunk first; each chunk lands in the history and is shown at once. */
  async function scanDown(top: bigint, bottom: bigint, onChunk: (lo: bigint) => void): Promise<boolean> {
    if (!readHits) return false;
    for (let hi = top; hi >= bottom; hi -= BigInt(HISTORY_CHUNK_BLOCKS)) {
      const lo = hi - BigInt(HISTORY_CHUNK_BLOCKS) + 1n > bottom ? hi - BigInt(HISTORY_CHUNK_BLOCKS) + 1n : bottom;
      const range = await readHits({ sessionId, fromBlock: lo, toBlock: hi, ...(historyPlayer ? { player: historyPlayer } : {}) });
      if (!running) return false;
      remember(range.hits);
      decodeErrors += range.decodeErrors;
      onChunk(lo);
      emitChange();
    }
    return true;
  }

  async function syncHistoryOnce(): Promise<void> {
    if (!historyEnabled || !readHead) return;
    const head = await readHead();
    if (!running) return;
    seeBlock(head);
    const start = session?.startBlock ?? head;
    const floor = windowFloor(head) > start ? windowFloor(head) : start;
    if (scannedTo === null) {
      // The live window first, so the stage shows the right notes as soon as possible.
      if (!(await scanDown(head, floor, (lo) => (historyFrom = lo)))) return;
      scannedTo = head;
      emitChange();
    } else if (head > scannedTo) {
      const overlapFrom = scannedTo - BigInt(RESYNC_OVERLAP_BLOCKS) + 1n;
      // Full history fills the whole gap; a window feed only needs what is still alive.
      const from = wantFull ? (overlapFrom > start ? overlapFrom : start) : overlapFrom > floor ? overlapFrom : floor;
      if (!(await scanDown(head, from, () => undefined))) return;
      scannedTo = head;
    }
    if (wantFull && historyFrom !== null && historyFrom > start) {
      await scanDown(historyFrom - 1n, start, (lo) => (historyFrom = lo));
    }
  }

  /** One history sync at a time; a request while one runs schedules exactly one more. Errors are reported, never swallowed. */
  function syncHistory(): Promise<void> {
    if (!historyEnabled) return Promise.resolve();
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        try {
          await syncHistoryOnce();
        } catch (error) {
          emitError(new Error(`history backfill failed: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
      } while (syncAgain && running);
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  let resyncing: Promise<void> | null = null;

  /**
   * Replace the local pattern and session with what the chain holds now; a failed read keeps
   * the current state. One resync at a time: a slow read must never land after a fresher one.
   */
  function resync(): Promise<void> {
    if (resyncing) return resyncing;
    resyncing = (async () => {
      try {
        await readChain();
      } catch (error) {
        emitError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (running) emitChange();
      await syncHistory();
    })().finally(() => {
      resyncing = null;
    });
    return resyncing;
  }

  function clearTimers(): void {
    if (resyncTimer !== null) clearInterval(resyncTimer);
    if (wsRetryTimer !== null) clearTimeout(wsRetryTimer);
    resyncTimer = null;
    wsRetryTimer = null;
  }

  function watch(nextMode: HitWatchMode, options: { resync: boolean } = { resync: true }): void {
    if (unwatch) {
      unwatch();
      unwatch = null;
    }
    if (unwatchTips) {
      unwatchTips();
      unwatchTips = null;
    }
    unwatchSplits?.();
    unwatchSplits = tipTotals
      ? (source.watchTipSplits?.({ sessionId, mode: nextMode, pollingIntervalMs, onSplits, onError: (error) => emitError(error) }) ?? null)
      : null;
    // Tips follow the hit watch's mode; their errors are reported, the hit watch decides the mode.
    unwatchTips =
      source.watchTips?.({
        sessionId,
        mode: nextMode,
        pollingIntervalMs,
        onTips,
        onError: (error) => emitError(error),
      }) ?? null;
    clearTimers();
    mode = nextMode;
    unwatch = source.watchHits({
      sessionId,
      mode: nextMode,
      pollingIntervalMs,
      onHits,
      onError(error) {
        emitError(error);
        if (!running) return;
        if (error instanceof HitDecodeError) {
          // One bad log is dropped and counted; the subscription itself is fine.
          decodeErrors += 1;
          emitChange();
          return;
        }
        if (mode === 'ws') {
          watch('poll');
          return;
        }
        connected = false;
        emitChange();
      },
    });
    connected = true;
    emitChange();
    if (nextMode === 'poll') {
      // Ordered so that when both fall due together the socket retry wins and the resync runs once, after it.
      wsRetryTimer = setTimeout(() => watch('ws'), wsRetryIntervalMs);
      resyncTimer = setInterval(() => void resync(), resyncIntervalMs);
    }
    if (options.resync) void resync();
  }

  return {
    getState,
    onHit(cb) {
      hitListeners.add(cb);
      return () => hitListeners.delete(cb);
    },
    onChange(cb) {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
    onError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    onTip(cb) {
      tipListeners.add(cb);
      return () => tipListeners.delete(cb);
    },
    start() {
      if (starting) return starting;
      running = true;
      starting = (async () => {
        try {
          await readChain();
        } catch (error) {
          running = false;
          connected = false;
          starting = null;
          throw error;
        }
        if (!running) return; // stopped while reading
        unsubscribeLatency = latency.subscribe(() => emitChange());
        unwatchSession =
          source.watchSession?.({
            sessionId,
            onSession(next) {
              if (!running) return;
              session = { ...next, tipPool: tipPoolWei };
              emitChange();
            },
          }) ?? null;
        watch('ws', { resync: false });
        const delay = options.initialSyncDelayMs ?? 0;
        if (delay > 0) {
          initialSyncTimer = setTimeout(() => {
            initialSyncTimer = null;
            void syncHistory();
          }, delay);
        } else {
          void syncHistory();
        }
      })();
      return starting;
    },
    requestFullHistory() {
      if (wantFull) return;
      wantFull = true;
      if (running && scannedTo !== null) void syncHistory();
    },
    stop() {
      running = false;
      starting = null;
      clearTimers();
      if (initialSyncTimer !== null) clearTimeout(initialSyncTimer);
      initialSyncTimer = null;
      if (unwatch) {
        unwatch();
        unwatch = null;
      }
      if (unwatchTips) {
        unwatchTips();
        unwatchTips = null;
      }
      unwatchSplits?.();
      unwatchSplits = null;
      unwatchSession?.();
      unwatchSession = null;
      if (unsubscribeLatency) {
        unsubscribeLatency();
        unsubscribeLatency = null;
      }
      connected = false;
      emitChange();
    },
  };
}

/** Merges two arrays already in chain order (O(n); backfill chunks arrive newest first). */
function mergeSorted(a: readonly HitEvent[], b: readonly HitEvent[]): HitEvent[] {
  const out: HitEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] as HitEvent;
    const y = b[j] as HitEvent;
    if (compareHits(x, y) <= 0) {
      out.push(x);
      i += 1;
    } else {
      out.push(y);
      j += 1;
    }
  }
  while (i < a.length) out.push(a[i++] as HitEvent);
  while (j < b.length) out.push(b[j++] as HitEvent);
  return out;
}
