/**
 * W13 note decay: the LIVE layer, derived deterministically from `Hit` logs.
 *
 * The contract keeps the RECORDED layer: `pattern()` XOR-toggles a bit per hit and is what
 * `finalize` mints. The live layer is what the room hears: every `Hit` is a note played at
 * its block, whatever its `on` flag, and a cell (step, track, note) stays alive for
 * `lifetimeBars` bars (16 blocks each) after its most recent hit. A later hit on the same
 * cell refreshes it; nothing a player does silences a note. See docs/adr/0001-note-decay.md.
 */
import type { Address } from 'viem';
import { NOTES_PER_TRACK, STEPS, TRACKS, type TrackId } from './constants';
import { bitIndex, emptyPattern } from './types';

/** A note lives 8 bars = 128 blocks (~38 s at 300 ms): it plays 8 times, the landing pass included. */
export const NOTE_LIFETIME_BARS = 8 as const;
/** The last 2 bars of a note's life fade out on the stage. */
export const FADE_BARS = 2 as const;
/** Voice cap: at most 6 live notes per track (48 of 128 cells, 37 %); the newest win. */
export const MAX_LIVE_PER_TRACK = 6 as const;
/** Largest lifetime the env knob accepts (an hour of 300 ms blocks is 750 bars). */
export const MAX_NOTE_LIFETIME_BARS = 750 as const;

/** The fields of a `Hit` event the live layer needs (HitEvent satisfies it). */
export interface LiveHit {
  blockNumber: bigint;
  logIndex: number;
  step: number;
  track: TrackId;
  note: number;
  player: Address;
  on: boolean;
}

export interface LiveCell {
  step: number;
  track: TrackId;
  note: number;
  /** Block of the most recent hit on this cell. */
  lastBlock: bigint;
  /** currentBlock − lastBlock, clamped at 0. */
  ageBlocks: number;
  /** Blocks until the cell goes dark; 1 on its last block alive. */
  remainingBlocks: number;
  /** Who hit it last (by blockNumber, logIndex). */
  player: Address;
  /** Hits on this cell in the replayed window (the last 2 lifetimes + the fade window). */
  hits: number;
}

/** A cell pushed out by the voice cap: silent now, shown fading on the stage for FADE_BARS bars. */
export interface EvictedCell {
  step: number;
  track: TrackId;
  note: number;
  /** Block of the hit that pushed it out. */
  evictedAt: bigint;
  /** currentBlock − evictedAt, clamped at 0. */
  sinceBlocks: number;
  /** Who hit it last before it was evicted. */
  player: Address;
}

export interface LivePattern {
  /** 16 step words of the alive cells, same bit layout as `pattern()`. */
  steps: bigint[];
  /** Alive cells sorted by (step, track, note). */
  cells: LiveCell[];
  count: number;
  /** Cells evicted by the voice cap within the last FADE_BARS bars, sorted by (step, track, note). */
  evicted: EvictedCell[];
}

export interface LivePatternOptions {
  /**
   * Voice cap: at most this many live notes per track, the newest by (blockNumber, logIndex)
   * win and the oldest are evicted. 0 or absent = no cap.
   */
  maxLivePerTrack?: number;
  /**
   * The input is already in chain order (blockNumber, logIndex), like the web feed's history:
   * skip the sort and find the replay window by binary search. Same result either way.
   */
  presorted?: boolean;
}

/**
 * First block that can still matter at `currentBlock`: a live or just-evicted cell was last hit
 * at or after currentBlock − lifetime − fade, and whether it was evicted depends only on the
 * voices of the lifetime before that hit. Older hits cannot change the result, so the replay
 * starts here and its cost stays bounded however long the session runs.
 */
export function replayFromBlock(currentBlock: bigint, lifetimeBars: number): bigint {
  const lifetime = noteLifetimeBlocks(lifetimeBars);
  const fade = BigInt(Math.min(FADE_BARS, lifetimeBars) * STEPS);
  const from = currentBlock - 2n * lifetime - fade;
  return from > 0n ? from : 0n;
}

/** Index of the first hit with blockNumber >= block in a chain-ordered array. */
function lowerBound(hits: readonly LiveHit[], block: bigint): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((hits[mid]?.blockNumber ?? 0n) < block) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function noteLifetimeBlocks(lifetimeBars: number): bigint {
  return BigInt(lifetimeBars) * BigInt(STEPS);
}

function assertLifetime(lifetimeBars: number): void {
  if (!Number.isInteger(lifetimeBars) || lifetimeBars <= 0) {
    throw new Error(`lifetimeBars must be a positive integer, got ${lifetimeBars}`);
  }
}

/** Orders hits the way the chain does: by block, then by log index inside the block. */
export function compareHits(a: Pick<LiveHit, 'blockNumber' | 'logIndex'>, b: Pick<LiveHit, 'blockNumber' | 'logIndex'>): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

interface CellState {
  hit: LiveHit;
  hits: number;
  /** Set when the voice cap pushed the cell out after its last hit. */
  evictedAt: bigint | null;
}

function cellKey(step: number, track: number, note: number): number {
  return (step * TRACKS + track) * NOTES_PER_TRACK + note;
}

/**
 * The cells alive at `currentBlock`. A cell is alive while currentBlock − lastBlock < lifetime
 * and the voice cap has not evicted it since its last hit. Hits are replayed in chain order
 * (blockNumber, logIndex): a hit refreshes its cell and makes it the track's newest voice; when
 * the track then holds more than `maxLivePerTrack` live notes, the oldest one is evicted.
 * Pure and order-independent (the input is sorted on a copy, never mutated).
 */
export function livePattern(hits: readonly LiveHit[], currentBlock: bigint, lifetimeBars: number, options: LivePatternOptions = {}): LivePattern {
  assertLifetime(lifetimeBars);
  const cap = options.maxLivePerTrack ?? 0;
  if (!Number.isInteger(cap) || cap < 0) throw new Error(`maxLivePerTrack must be 0 (no cap) or a positive integer, got ${cap}`);
  const lifetime = noteLifetimeBlocks(lifetimeBars);
  const ordered = options.presorted ? hits : [...hits].sort(compareHits);
  const sorted = ordered.slice(lowerBound(ordered, replayFromBlock(currentBlock, lifetimeBars)));
  const cells = new Map<number, CellState>();
  /** Per track, the live voices oldest first (only maintained with a cap). */
  const voices: number[][] = Array.from({ length: TRACKS }, () => []);
  for (const hit of sorted) {
    const key = cellKey(hit.step, hit.track, hit.note);
    const prev = cells.get(key);
    cells.set(key, { hit, hits: (prev?.hits ?? 0) + 1, evictedAt: null });
    if (cap === 0) continue;
    // Voices that expired before this hit no longer take a place.
    const queue = (voices[hit.track] ?? []).filter((k) => {
      if (k === key) return false;
      const c = cells.get(k);
      return c !== undefined && hit.blockNumber - c.hit.blockNumber < lifetime;
    });
    queue.push(key);
    while (queue.length > cap) {
      const oldest = queue.shift();
      const c = oldest === undefined ? undefined : cells.get(oldest);
      if (c) c.evictedAt = hit.blockNumber;
    }
    voices[hit.track] = queue;
  }
  const steps = emptyPattern();
  const live: LiveCell[] = [];
  const evicted: EvictedCell[] = [];
  const ghostBlocks = BigInt(Math.min(FADE_BARS, lifetimeBars) * STEPS);
  for (const key of [...cells.keys()].sort((a, b) => a - b)) {
    const entry = cells.get(key);
    if (!entry) continue;
    const { hit } = entry;
    if (entry.evictedAt !== null) {
      const since = currentBlock > entry.evictedAt ? currentBlock - entry.evictedAt : 0n;
      if (since < ghostBlocks) {
        evicted.push({ step: hit.step, track: hit.track, note: hit.note, evictedAt: entry.evictedAt, sinceBlocks: Number(since), player: hit.player });
      }
      continue;
    }
    const age = currentBlock > hit.blockNumber ? currentBlock - hit.blockNumber : 0n;
    if (age >= lifetime) continue;
    steps[hit.step] = (steps[hit.step] ?? 0n) | (1n << bitIndex(hit.track, hit.note));
    live.push({
      step: hit.step,
      track: hit.track,
      note: hit.note,
      lastBlock: hit.blockNumber,
      ageBlocks: Number(age),
      remainingBlocks: Number(lifetime - age),
      player: hit.player,
      hits: entry.hits,
    });
  }
  return { steps, cells: live, count: live.length, evicted };
}

/**
 * Brightness of a live cell from its remaining life: 1 until the last FADE_BARS bars, then
 * linear toward 0. With reduced motion it steps once per bar (no per-block change).
 */
export function fadeOf(remainingBlocks: number, lifetimeBars: number, options: { reducedMotion?: boolean } = {}): number {
  if (remainingBlocks <= 0) return 0;
  const fadeBlocks = Math.min(FADE_BARS, lifetimeBars) * STEPS;
  if (remainingBlocks >= fadeBlocks) return 1;
  if (options.reducedMotion) {
    const barsLeft = Math.ceil(remainingBlocks / STEPS);
    return barsLeft * STEPS >= fadeBlocks ? 1 : (barsLeft * STEPS) / fadeBlocks;
  }
  return remainingBlocks / fadeBlocks;
}

/**
 * Reads the NOTE_LIFETIME_BARS knob (web: NEXT_PUBLIC_NOTE_LIFETIME_BARS, agent: the same or
 * NOTE_LIFETIME_BARS). Unset → 8. `0` turns decay off: the apps play the recorded pattern.
 */
export function parseNoteLifetimeBars(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return NOTE_LIFETIME_BARS;
  if (!/^\d+$/.test(value) || Number(value) > MAX_NOTE_LIFETIME_BARS) {
    throw new Error(`NOTE_LIFETIME_BARS must be 0 (no decay) or a whole number of bars up to ${MAX_NOTE_LIFETIME_BARS}, got "${value}"`);
  }
  return Number(value);
}

/**
 * Brightness of a cell the voice cap just evicted: it goes silent at once and its light
 * fades from half brightness to dark over FADE_BARS bars (whole bars with reduced motion).
 */
export function ghostFadeOf(sinceBlocks: number, lifetimeBars: number, options: { reducedMotion?: boolean } = {}): number {
  const fadeBlocks = Math.min(FADE_BARS, lifetimeBars) * STEPS;
  const left = Math.max(0, fadeBlocks - Math.max(0, sinceBlocks));
  return 0.5 * fadeOf(left, lifetimeBars, options);
}

/** Reads the MAX_LIVE_PER_TRACK knob (NEXT_PUBLIC_MAX_LIVE_PER_TRACK). Unset → 6, `0` = no cap. */
export function parseMaxLivePerTrack(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return MAX_LIVE_PER_TRACK;
  const max = STEPS * NOTES_PER_TRACK;
  if (!/^\d+$/.test(value) || Number(value) > max) {
    throw new Error(`MAX_LIVE_PER_TRACK must be 0 (no cap) or a whole number up to ${max}, got "${value}"`);
  }
  return Number(value);
}
