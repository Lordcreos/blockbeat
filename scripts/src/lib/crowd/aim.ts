/**
 * W19: aimed steps for the simulated players, the phone's technique (W16, apps/web/lib/join/aim.ts):
 * the contract takes the step from the block a hit lands in, so a player only chooses WHEN
 * to send. A note planned for (bar, step) targets one block T; it is sent when the clock
 * position (last head + time since it arrived, in blocks) reaches T − mean(y), where y is the
 * measured inclusion delay (landed block − position at send) of the last landings.
 */
import { STEPS } from '@blockbeat/shared';

export const LEAD_WINDOW = 8;
export const MAX_LEAD_BLOCKS = 8;
/** Monad from a laptop: a send lands one or two blocks after the position it fired at. */
export const INITIAL_LEAD_BLOCKS = 1.5;

/** Block where crowd bar 0 starts: the first loop boundary strictly after `head`. */
export function playStartBlock(startBlock: bigint, head: bigint): bigint {
  const loop = STEPS_BIG;
  const offset = (((head - startBlock) % loop) + loop) % loop;
  return head + (loop - offset);
}

const STEPS_BIG = BigInt(STEPS);

export function noteTargetBlock(playStart: bigint, bar: number, step: number): bigint {
  return playStart + BigInt(bar * STEPS + step);
}

export interface Lead {
  mean(): number;
  record(inclusionDelayBlocks: number): void;
}

export function createLead(initial: number = INITIAL_LEAD_BLOCKS, window: number = LEAD_WINDOW): Lead {
  const samples: number[] = [];
  let mean = initial;
  return {
    mean: () => mean,
    record(y) {
      if (!Number.isFinite(y)) return;
      samples.push(Math.max(0, y));
      while (samples.length > window) samples.shift();
      mean = Math.min(MAX_LEAD_BLOCKS, samples.reduce((a, b) => a + b, 0) / samples.length);
    },
  };
}
