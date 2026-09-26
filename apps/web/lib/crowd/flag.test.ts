import { describe, expect, it } from 'vitest';
import { crowdEnabled } from './flag';

describe('crowdEnabled', () => {
  it('is off unless NEXT_PUBLIC_CROWD_ENABLED is exactly 1', () => {
    expect(crowdEnabled(undefined)).toBe(false);
    expect(crowdEnabled('')).toBe(false);
    expect(crowdEnabled('0')).toBe(false);
    expect(crowdEnabled('true')).toBe(false);
    expect(crowdEnabled('1')).toBe(true);
    expect(crowdEnabled(' 1 ')).toBe(true);
  });
});
