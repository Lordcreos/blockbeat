import { describe, expect, it } from 'vitest';
import { STEPS } from '@blockbeat/shared';
import { classifyLanding, predictLanding, stepDelta } from '../src/lib/stepPrediction';

describe('predictLanding', () => {
  const base = { startBlock: 100n, blockMs: 300, lagBlocks: 1 };

  it('predicts head + lag + 1 right after a head was seen', () => {
    const out = predictLanding({ ...base, head: 110n, headSeenAt: 1000, now: 1000 });
    expect(out.block).toBe(112n);
    expect(out.step).toBe(12);
  });

  it('accounts for blocks that elapsed since the head was seen', () => {
    const out = predictLanding({ ...base, head: 110n, headSeenAt: 1000, now: 1700 });
    // 700 ms at 300 ms per block = 2 whole blocks elapsed.
    expect(out.block).toBe(114n);
    expect(out.step).toBe(14);
  });

  it('wraps the step at 16 like the contract', () => {
    const out = predictLanding({ ...base, head: 115n, headSeenAt: 0, now: 0 });
    expect(out.block).toBe(117n);
    expect(out.step).toBe((117 - 100) % STEPS);
  });

  it('uses zero lag when asked (instant-mining chains)', () => {
    const out = predictLanding({ ...base, lagBlocks: 0, head: 110n, headSeenAt: 0, now: 0 });
    expect(out.block).toBe(111n);
  });

  it('never predicts before the session start block', () => {
    const out = predictLanding({ ...base, head: 50n, headSeenAt: 0, now: 0 });
    expect(out.block).toBe(52n);
    expect(out.step).toBe(0);
  });

  it('rejects a clock that runs backwards', () => {
    expect(() => predictLanding({ ...base, head: 1n, headSeenAt: 500, now: 100 })).toThrow(/now/);
  });
});

describe('stepDelta and classifyLanding', () => {
  it('is zero for the same step', () => {
    expect(stepDelta(5, 5)).toBe(0);
    expect(classifyLanding(5, 5)).toBe('on-time');
  });

  it('is one for the next step, including across the wrap', () => {
    expect(stepDelta(5, 6)).toBe(1);
    expect(stepDelta(15, 0)).toBe(1);
    expect(classifyLanding(15, 0)).toBe('one-late');
  });

  it('is negative for an early landing across the wrap', () => {
    expect(stepDelta(0, 15)).toBe(-1);
    expect(classifyLanding(0, 15)).toBe('early');
  });

  it('classifies two or more steps late as late', () => {
    expect(classifyLanding(3, 5)).toBe('late');
    expect(classifyLanding(3, 11)).toBe('late');
  });

  it('rejects steps outside 0..15', () => {
    expect(() => stepDelta(16, 0)).toThrow(/step/);
    expect(() => stepDelta(0, -1)).toThrow(/step/);
  });
});
