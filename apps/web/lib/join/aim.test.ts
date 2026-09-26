import { describe, expect, it } from 'vitest';
import { stepForBlock } from '@blockbeat/shared';
import { MAX_LEAD_BLOCKS, MIN_LEAD_BLOCKS, aimOutcome, createLeadTracker, stepDelta, targetBlockFor } from './aim';

describe('targetBlockFor', () => {
  const start = 1000n;

  it('picks the next block whose step is the aimed one, at least `lead` blocks ahead', () => {
    // head 1000 is step 0; lead 1 → the earliest landing is 1001 (step 1)
    expect(targetBlockFor(start, 1000n, 1, 1)).toBe(1001n);
    expect(targetBlockFor(start, 1000n, 7, 1)).toBe(1007n);
    // step 0 needs a landing >= 1001, so the next loop
    expect(targetBlockFor(start, 1000n, 0, 1)).toBe(1016n);
  });

  it('wraps into the next loop when the step is too close for the lead', () => {
    // head 1005 (step 5), lead 2: step 6 would need a landing on 1006 < 1007 → next loop
    expect(targetBlockFor(start, 1005n, 6, 2)).toBe(1022n);
    expect(targetBlockFor(start, 1005n, 7, 2)).toBe(1007n);
  });

  it('always lands on the aimed step', () => {
    for (let head = 1000n; head < 1040n; head++) {
      for (let step = 0; step < 16; step++) {
        for (const lead of [1, 2, 3]) {
          const t = targetBlockFor(start, head, step, lead);
          expect(stepForBlock(start, t)).toBe(step);
          expect(t - head).toBeGreaterThanOrEqual(BigInt(lead));
          expect(t - head).toBeLessThan(BigInt(lead + 16));
        }
      }
    }
  });

  it('rejects a step outside 0..15', () => {
    expect(() => targetBlockFor(start, 1000n, 16, 1)).toThrow(RangeError);
    expect(() => targetBlockFor(start, 1000n, -1, 1)).toThrow(RangeError);
  });
});

describe('stepDelta and aimOutcome', () => {
  it('measures the shortest way round the loop', () => {
    expect(stepDelta(7, 7)).toBe(0);
    expect(stepDelta(7, 8)).toBe(1);
    expect(stepDelta(7, 6)).toBe(-1);
    expect(stepDelta(15, 0)).toBe(1);
    expect(stepDelta(0, 15)).toBe(-1);
    expect(stepDelta(0, 8)).toBe(8);
  });

  it('says honestly where the note landed', () => {
    expect(aimOutcome(7, 7)).toEqual({ delta: 0, text: 'aimed step 7 · landed step 7' });
    expect(aimOutcome(7, 8).text).toBe('aimed step 7 · landed step 8 (one late)');
    expect(aimOutcome(7, 6).text).toBe('aimed step 7 · landed step 6 (one early)');
    expect(aimOutcome(2, 5).text).toBe('aimed step 2 · landed step 5 (3 late)');
    expect(aimOutcome(15, 0).text).toBe('aimed step 15 · landed step 0 (one late)');
  });
});

describe('createLeadTracker', () => {
  it('starts at 1 block', () => {
    expect(createLeadTracker().lead()).toBe(1);
  });

  it('learns a lead of 0 on a link fast enough that a send on the tick lands in that block', () => {
    const t = createLeadTracker();
    t.record(0);
    t.record(0);
    expect(t.lead()).toBe(0);
    expect(MIN_LEAD_BLOCKS).toBe(0);
  });

  it('learns the rounded mean inclusion delay of the last 4 landings', () => {
    const t = createLeadTracker();
    t.record(2);
    expect(t.lead()).toBe(2);
    t.record(2);
    t.record(1);
    t.record(1);
    expect(t.lead()).toBe(2); // mean 1.5 rounds up
    t.record(1);
    expect(t.lead()).toBe(1); // window drops the oldest 2: mean 1.25
  });

  it('clamps to [MIN, MAX] and ignores junk samples', () => {
    const t = createLeadTracker();
    t.record(40);
    expect(t.lead()).toBe(MAX_LEAD_BLOCKS);
    const u = createLeadTracker();
    u.record(0);
    u.record(-3);
    expect(u.lead()).toBe(MIN_LEAD_BLOCKS);
    const v = createLeadTracker();
    v.record(Number.NaN);
    expect(v.lead()).toBe(1);
    expect(v.samples()).toEqual([]);
  });

  it('keeps the fractional mean for sub-block timing', () => {
    const means: number[] = [];
    const t = createLeadTracker({ onMeanChange: (m) => means.push(m) });
    expect(t.mean()).toBe(1);
    t.record(6.2);
    t.record(6.8);
    expect(t.mean()).toBeCloseTo(6.5, 5);
    expect(t.lead()).toBe(7);
    expect(means).toEqual([6.2, 6.5]);
    t.record(40);
    expect(t.mean()).toBeLessThanOrEqual(MAX_LEAD_BLOCKS);
  });

  it('reports lead changes to a listener', () => {
    const seen: number[] = [];
    const t = createLeadTracker({ onChange: (lead) => seen.push(lead) });
    t.record(1);
    t.record(3);
    expect(seen).toEqual([2]);
  });
});
