import { describe, expect, it } from 'vitest';
import { trailOf } from './playhead';

describe('trailOf', () => {
  it('is 0 on the playhead column itself', () => {
    expect(trailOf(5, 5)).toBe(0);
  });
  it('counts how many steps behind the playhead a column is, up to the trail length', () => {
    expect(trailOf(4, 5)).toBe(1);
    expect(trailOf(3, 5)).toBe(2);
  });
  it('wraps around the loop end', () => {
    expect(trailOf(15, 0)).toBe(1);
    expect(trailOf(14, 0)).toBe(2);
  });
  it('returns null for columns outside the trail', () => {
    expect(trailOf(2, 5)).toBeNull();
    expect(trailOf(6, 5)).toBeNull();
  });
});
