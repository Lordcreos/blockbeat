import { STEPS } from '@blockbeat/shared';

/** How many columns the trail keeps lit behind the playhead. */
export const TRAIL_LENGTH = 2;

/**
 * Distance of `step` behind the playhead (`current`), wrapping at the loop end:
 * 0 on the playhead itself, 1..TRAIL_LENGTH inside the trail, null elsewhere.
 */
export function trailOf(step: number, current: number): number | null {
  const behind = (current - step + STEPS) % STEPS;
  return behind <= TRAIL_LENGTH ? behind : null;
}
