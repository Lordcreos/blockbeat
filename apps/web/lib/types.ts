/**
 * Interfaces shared by the web app. Extend them; never rename or remove an exported name.
 */
import type { Address, Hash } from 'viem';
import type { HitEvent, Pattern, SessionState, TrackId } from '@blockbeat/shared';

export type { HitEvent, Pattern, SessionState, TrackId };

// ---------------------------------------------------------------- block clock

export interface BlockClockState {
  /** Latest head seen (or simulated). */
  currentBlock: bigint;
  /** 0..15, derived from currentBlock and the session startBlock. */
  currentStep: number;
  /** Measured average block interval over the last ~32 heads, ms. Starts at 300. */
  measuredBlockMs: number;
  /** ms since the last head arrived (for UI freshness). */
  msSinceHead: number;
  /** 'ws' when subscribed over WebSocket, 'poll' when falling back, 'mock' in mock mode. */
  source: 'ws' | 'poll' | 'mock';
}

export interface BlockClock {
  getState(): BlockClockState;
  /** Fires once per step with the step index and the audio-context time it should sound at. */
  onStep(cb: (step: number, atAudioTime: number) => void): () => void;
  onHead(cb: (blockNumber: bigint) => void): () => void;
  /** Predicted block number that will be current at `msFromNow`. */
  predictBlock(msFromNow: number): bigint;
  start(): void;
  stop(): void;
  /**
   * Optional (added by W4): the audio engine calls this once its context is running so the
   * clock can express `atAudioTime` on the AudioContext time base. Only `currentTime` is
   * required, which keeps Tone's wrapped context and a native BaseAudioContext both valid.
   */
  setAudioClock?(ctx: Pick<BaseAudioContext, 'currentTime'>): void;
}

// ---------------------------------------------------------------- event feed

/** One decoded `Tipped` event (W12). */
export interface TipEvent {
  sessionId: bigint;
  from: Address;
  amountWei: bigint;
  blockNumber: bigint;
  txHash: Hash;
  logIndex: number;
  /** W21b: the W21a split of this tip (TipSplit event; the simulator computes it). Absent before W21a. */
  split?: { hostWei: bigint; poolWei: bigint };
}

export interface EventFeedState {
  pattern: Pattern;
  session: SessionState | null;
  hitCount: number;
  uniquePlayers: number;
  hitsPerMinute: number;
  /** Rolling average confirmation latency reported by hit senders on this device, ms. */
  avgLatencyMs: number | null;
  connected: boolean;
  /** Hit logs the feed could not decode (dropped, counted here instead of only warned; review L6). */
  decodeErrors: number;
  /** W12: the session's tip pool, from getSession and then every Tipped event. */
  tipPoolWei: bigint;
  /** W12: tips so far: the pool at load over the fixed app tip, plus every Tipped event seen since. */
  tipCount: number;
  /** W21b: raised by the session: pool + host share at load, plus every Tipped amount since. */
  raisedWei: bigint;
  /** W21b: Tipped events seen live, newest last (at most LIVE_TIPS_LIMIT); older tips come from /api/tip-note. */
  tips: readonly TipEvent[];
  /**
   * W13: every Hit the feed knows for the session (backfill + live), sorted by (blockNumber,
   * logIndex). The live, decaying layer is derived from it; `pattern` above is the RECORDED
   * layer (the contract's XOR bitmask, what finalize mints).
   */
  hits: readonly HitEvent[];
  /** W13: true once the live window has been read from the chain (or when there is nothing to read). */
  historyReady: boolean;
  /** W13: lowest block the history covers; null before the first backfill. */
  historyFrom: bigint | null;
  /**
   * W13: the newest block this feed has seen (a head read or a live Hit) and when, by the
   * device clock. Phones run no block clock; they estimate the head from it at 300 ms a block.
   */
  headHint: { block: bigint; atMs: number } | null;
}

export interface EventFeed {
  getState(): EventFeedState;
  onHit(cb: (hit: HitEvent) => void): () => void;
  onChange(cb: (state: EventFeedState) => void): () => void;
  /** W12: fires once per new Tipped event of the session. */
  onTip(cb: (tip: TipEvent) => void): () => void;
  start(): Promise<void>;
  stop(): void;
}

// ---------------------------------------------------------------- burner + hits

export interface BurnerWallet {
  address: Address;
  /** True when a key existed in storage before this page load. */
  restored: boolean;
  /** False when the key lives in memory only (private mode, blocked storage): a reload means a new wallet (review L2). */
  persisted?: boolean;
}

export interface HitReceipt {
  txHash: Hash;
  blockNumber: bigint;
  step: number;
  on: boolean;
  latencyMs: number;
}

export interface HitSender {
  /** Resolves when the Hit log for this tx is seen. Rejects on send or timeout. */
  send(sessionId: bigint, track: TrackId, note: number): Promise<HitReceipt>;
  /** Number of hits in flight (for optimistic UI). */
  pending(): number;
}

export interface TipReceipt {
  txHash: Hash;
  blockNumber: bigint;
  amountWei: bigint;
  latencyMs: number;
}

export interface TipSender {
  /**
   * Sends a tip to the session and resolves on the receipt. Rejects on send, revert or timeout.
   * W21b: `amountWei` is the amount the tipper picked (defaults to the app's fixed tip).
   */
  send(sessionId: bigint, amountWei?: bigint): Promise<TipReceipt>;
  /** Number of tips in flight. */
  pending(): number;
}

export interface DripResult {
  txHash: Hash | null;
  /** Track assigned to this player for the session (round robin). */
  track: TrackId;
  /** True if the address was already funded. */
  alreadyFunded: boolean;
  /** Drips that were queued ahead of this one (W11 reserve pacing); absent when unknown. */
  queuedAhead?: number;
  /** Expected wait in the queue at request time, ms; 0 when the drip is not paced. */
  etaMs?: number;
  /** W12: true when this transfer was a top-up of an already funded wallet. */
  topUp?: boolean;
  /** W12: top-ups this wallet may still ask for (present on top-up answers). */
  topUpsLeft?: number;
}

// ---------------------------------------------------------------- audio (W4)

export interface AudioEngine {
  /** Must be called from a user gesture. Idempotent. */
  start(): Promise<void>;
  isStarted(): boolean;
  /** Replace the pattern the player loops over. */
  setPattern(pattern: Pattern): void;
  /** Bind to a clock; the engine schedules each step from clock.onStep. */
  attachClock(clock: BlockClock): () => void;
  /** Play one note now (a hit that landed on the current step). */
  playImmediate(track: TrackId, note: number): void;
  setMasterVolumeDb(db: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------- session ids

/** Route param → bigint. Returns null when not a positive integer. */
export function parseSessionId(raw: string | undefined): bigint | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = BigInt(raw);
  return id > 0n ? id : null;
}
