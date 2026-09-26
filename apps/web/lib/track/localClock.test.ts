import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_MS } from '@blockbeat/shared';
import { LOCAL_CLOCK_LOOKAHEAD_MS, createLocalClock } from './localClock';

describe('createLocalClock (a BlockClock with no chain behind it)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing until start()', () => {
    const clock = createLocalClock();
    const steps: number[] = [];
    clock.onStep((s) => steps.push(s));
    vi.advanceTimersByTime(3000);
    expect(steps).toEqual([]);
    expect(clock.getState().source).toBe('mock');
  });

  it('fires step 0 at once, then one step every 300 ms, wrapping after 16', () => {
    const clock = createLocalClock();
    const steps: number[] = [];
    clock.onStep((s) => steps.push(s));
    clock.start();
    expect(steps).toEqual([0]);
    vi.advanceTimersByTime(BLOCK_MS * 17);
    expect(steps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1]);
    expect(clock.getState().currentStep).toBe(1);
    expect(clock.getState().currentBlock).toBe(17n);
    expect(clock.getState().measuredBlockMs).toBe(BLOCK_MS);
  });

  it('hands each step its audio time, ahead of the wall clock by the lookahead', () => {
    // An audio context that started 10 s before the wall clock's zero.
    const clock = createLocalClock();
    clock.setAudioClock({
      get currentTime() {
        return 10 + Date.now() / 1000;
      },
    });
    const at: number[] = [];
    clock.onStep((_s, t) => at.push(t));
    clock.start();
    expect(at[0]).toBeCloseTo(10 + LOCAL_CLOCK_LOOKAHEAD_MS / 1000, 5);
    vi.advanceTimersByTime(BLOCK_MS * 2);
    expect(at).toHaveLength(3);
    // Step k sounds at start + lookahead + k × 300 ms on the audio time base.
    expect(at[1]).toBeCloseTo(10 + (BLOCK_MS + LOCAL_CLOCK_LOOKAHEAD_MS) / 1000, 5);
    expect(at[2]).toBeCloseTo(10 + (2 * BLOCK_MS + LOCAL_CLOCK_LOOKAHEAD_MS) / 1000, 5);
  });

  it('does not drift: step k fires at k × 300 ms even when timers run late', () => {
    const fired: number[] = [];
    const clock = createLocalClock({ lookaheadMs: 0 });
    clock.onStep(() => fired.push(Date.now()));
    clock.start();
    vi.advanceTimersByTime(BLOCK_MS * 40);
    expect(fired).toHaveLength(41);
    fired.forEach((t, k) => expect(t).toBe(k * BLOCK_MS));
  });

  it('stop() silences it and a restart begins again at step 0', () => {
    const clock = createLocalClock();
    const steps: number[] = [];
    clock.onStep((s) => steps.push(s));
    clock.start();
    vi.advanceTimersByTime(BLOCK_MS * 3);
    clock.stop();
    vi.advanceTimersByTime(BLOCK_MS * 5);
    expect(steps).toEqual([0, 1, 2, 3]);
    clock.start();
    expect(steps.at(-1)).toBe(0);
  });

  it('start() twice does not double the steps', () => {
    const clock = createLocalClock();
    const steps: number[] = [];
    clock.onStep((s) => steps.push(s));
    clock.start();
    clock.start();
    vi.advanceTimersByTime(BLOCK_MS);
    expect(steps).toEqual([0, 1]);
  });

  it('unsubscribes listeners and predicts blocks from its own cadence', () => {
    const clock = createLocalClock();
    const steps: number[] = [];
    const heads: bigint[] = [];
    const off = clock.onStep((s) => steps.push(s));
    clock.onHead((b) => heads.push(b));
    clock.start();
    off();
    vi.advanceTimersByTime(BLOCK_MS * 2);
    expect(steps).toEqual([0]);
    expect(heads).toEqual([0n, 1n, 2n]);
    expect(clock.predictBlock(BLOCK_MS * 3)).toBe(5n);
  });
});
