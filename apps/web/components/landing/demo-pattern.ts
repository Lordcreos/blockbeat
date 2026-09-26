import { STEPS, TRACKS } from '@blockbeat/shared';

function row(...steps: number[]): boolean[] {
  const out = Array.from({ length: STEPS }, () => false);
  for (const s of steps) out[s] = true;
  return out;
}

/**
 * The loop the landing page plays: a plain techno bar so every track colour shows and the
 * kick lands on the quarter notes. Rows follow TRACK_META order.
 */
export const DEMO_PATTERN: readonly (readonly boolean[])[] = [
  row(0, 4, 8, 12), // kick
  row(4, 12), // snare
  row(2, 6, 10, 14), // hat
  row(12, 15), // clap
  row(0, 3, 7, 8, 11), // bass
  row(5, 9, 13), // lead
  row(0, 8), // pad
  row(14), // fx
];

if (DEMO_PATTERN.length !== TRACKS) throw new Error('DEMO_PATTERN must have one row per track');
