import { describe, expect, it } from 'vitest';
import { createLatencyTracker } from './latency';

describe('createLatencyTracker', () => {
  it('starts with no average', () => {
    expect(createLatencyTracker().average()).toBeNull();
  });

  it('averages the recorded samples and notifies subscribers', () => {
    const t = createLatencyTracker();
    const seen: Array<number | null> = [];
    const off = t.subscribe((avg) => seen.push(avg));
    t.record(300);
    t.record(500);
    expect(t.average()).toBe(400);
    expect(seen).toEqual([300, 400]);
    off();
    t.record(700);
    expect(seen).toHaveLength(2);
  });

  it('keeps only the last N samples', () => {
    const t = createLatencyTracker(2);
    t.record(100);
    t.record(200);
    t.record(300);
    expect(t.average()).toBe(250);
  });

  it('rejects non-finite or negative samples', () => {
    const t = createLatencyTracker();
    expect(() => t.record(-1)).toThrow(/latency/);
    expect(() => t.record(Number.NaN)).toThrow(/latency/);
  });
});
