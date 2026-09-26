/**
 * Turns clock steps into instrument triggers. Framework- and WebAudio-free: it only knows a
 * `TriggerSink` and a `now()` function, so the scheduling rules are unit-testable.
 */
import { STEPS, decodeStep, type Pattern, type TrackId } from '@blockbeat/shared';
import type { BlockClock } from '../types';

export interface TriggerSink {
  trigger(track: TrackId, note: number, atAudioTime: number): void;
}

export interface PatternPlayerOptions {
  /** Current audio-context time in seconds. */
  now(): number;
  /** Never schedule closer than this to `now()`; gives the graph time to apply automation. */
  minLeadSec?: number;
  /** Steps whose time is further in the past than this are dropped, not played late. */
  lateToleranceSec?: number;
}

export const DEFAULT_MIN_LEAD_SEC = 0.02;
export const DEFAULT_LATE_TOLERANCE_SEC = 0.25;

export function assertPattern(pattern: Pattern): void {
  if (!Array.isArray(pattern) || pattern.length !== STEPS) {
    const got = Array.isArray(pattern) ? pattern.length : typeof pattern;
    throw new RangeError(`pattern must have exactly ${STEPS} step words, got ${got}`);
  }
}

export class PatternPlayer {
  private pattern: Pattern = Array.from({ length: STEPS }, () => 0n);
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;
  private readonly minLeadSec: number;
  private readonly lateToleranceSec: number;

  constructor(
    private readonly sink: TriggerSink,
    options: PatternPlayerOptions,
  ) {
    this.now = options.now;
    this.minLeadSec = options.minLeadSec ?? DEFAULT_MIN_LEAD_SEC;
    this.lateToleranceSec = options.lateToleranceSec ?? DEFAULT_LATE_TOLERANCE_SEC;
  }

  setPattern(pattern: Pattern): void {
    assertPattern(pattern);
    this.pattern = [...pattern];
  }

  getPattern(): Pattern {
    return [...this.pattern];
  }

  /** Subscribes to the clock; replaces any previous clock. Returns an unsubscribe. */
  attachClock(clock: Pick<BlockClock, 'onStep'>): () => void {
    this.detach();
    const off = clock.onStep((step, at) => this.onStep(step, at));
    const unsubscribe = () => {
      if (this.unsubscribe === unsubscribe) this.unsubscribe = null;
      off();
    };
    this.unsubscribe = unsubscribe;
    return unsubscribe;
  }

  detach(): void {
    const off = this.unsubscribe;
    this.unsubscribe = null;
    off?.();
  }

  onStep(step: number, atAudioTime: number): void {
    if (!Number.isInteger(step) || step < 0 || step >= STEPS) return;
    const word = this.pattern[step] ?? 0n;
    if (word === 0n) return;
    const when = this.resolveTime(atAudioTime);
    if (when === null) return;
    for (const { track, note } of decodeStep(word)) this.sink.trigger(track, note, when);
  }

  triggerNow(track: TrackId, note: number): void {
    this.sink.trigger(track, note, this.now() + this.minLeadSec);
  }

  private resolveTime(atAudioTime: number): number | null {
    // NaN compares false with everything, so it must be rejected explicitly or it would sail
    // through the late check and end up as a Tone schedule time.
    if (!Number.isFinite(atAudioTime)) return null;
    const now = this.now();
    if (atAudioTime < now - this.lateToleranceSec) return null;
    return Math.max(atAudioTime, now + this.minLeadSec);
  }
}
