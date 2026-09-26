import type { Address, Hash } from 'viem';
import { NOTES_PER_TRACK, STEPS, TRACKS, type TrackId } from './constants';

/** One decoded `Hit` event. */
export interface HitEvent {
  sessionId: bigint;
  player: Address;
  blockNumber: bigint;
  step: number;
  track: TrackId;
  note: number;
  on: boolean;
  txHash: Hash;
  logIndex: number;
}

/** One session, as returned by `getSession`. */
export interface SessionState {
  sessionId: bigint;
  startBlock: bigint;
  host: Address;
  finalized: boolean;
  hitCount: bigint;
  tokenId: bigint;
  parentSessionId: bigint;
  tipPool: bigint;
}

/** 16 step words, one uint256 per step, bit index = track * 32 + note. */
export type Pattern = readonly bigint[]; // length STEPS

export function emptyPattern(): bigint[] {
  return Array.from({ length: STEPS }, () => 0n);
}

export function bitIndex(track: TrackId, note: number): bigint {
  return BigInt(track * NOTES_PER_TRACK + note);
}

export function isOn(stepWord: bigint, track: TrackId, note: number): boolean {
  return ((stepWord >> bitIndex(track, note)) & 1n) === 1n;
}

export function toggle(stepWord: bigint, track: TrackId, note: number): bigint {
  return stepWord ^ (1n << bitIndex(track, note));
}

/** All (track, note) pairs that are on in a step word. */
export function decodeStep(stepWord: bigint): Array<{ track: TrackId; note: number }> {
  const out: Array<{ track: TrackId; note: number }> = [];
  if (stepWord === 0n) return out;
  for (let t = 0; t < TRACKS; t++) {
    const trackBits = (stepWord >> BigInt(t * NOTES_PER_TRACK)) & ((1n << BigInt(NOTES_PER_TRACK)) - 1n);
    if (trackBits === 0n) continue;
    for (let n = 0; n < NOTES_PER_TRACK; n++) {
      if (((trackBits >> BigInt(n)) & 1n) === 1n) out.push({ track: t as TrackId, note: n });
    }
  }
  return out;
}

/** Step for a block, identical to Blockbeat.stepOf. */
export function stepForBlock(startBlock: bigint, blockNumber: bigint): number {
  if (blockNumber < startBlock) return 0;
  return Number((blockNumber - startBlock) % BigInt(STEPS));
}

/** Apply a hit event to a pattern immutably. */
export function applyHit(pattern: Pattern, hit: HitEvent): bigint[] {
  const next = [...pattern];
  const word = next[hit.step] ?? 0n;
  next[hit.step] = toggle(word, hit.track, hit.note);
  return next;
}
