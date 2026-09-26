import { STEPS, TRACKS } from '@blockbeat/shared';
import { describe, expect, it } from 'vitest';
import { DEMO_PATTERN } from './demo-pattern';

describe('DEMO_PATTERN', () => {
  it('is one row per track and one cell per step', () => {
    expect(DEMO_PATTERN).toHaveLength(TRACKS);
    for (const row of DEMO_PATTERN) expect(row).toHaveLength(STEPS);
  });
  it('puts the kick on every quarter note', () => {
    expect(DEMO_PATTERN[0]).toEqual([true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false]);
  });
  it('lights something on every track so all eight colours show', () => {
    for (const row of DEMO_PATTERN) expect(row.some(Boolean)).toBe(true);
  });
});
