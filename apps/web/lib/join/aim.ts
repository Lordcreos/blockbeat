/**
 * W16: aimed steps. The contract derives the step from the block a hit lands in, so the phone
 * cannot choose it; it can only choose WHEN to send. The same technique as the DJ agent
 * (apps/agent/src/lib/scheduler.ts): find the next block whose step is the aimed one, send
 * `lead` blocks before it, and learn the lead from this phone's own measured inclusion delay
 * (landed block − head at send). Pure, so the arithmetic is unit tested.
 */
import { STEPS, stepForBlock } from '@blockbeat/shared';

/**
 * The phone sends on the block clock's tick, which is predicted and fires just before the
 * phone expects the head. On a fast link (the simulator, a good LAN) that tick comes before
 * the block is produced, so a send on "head B" can still land in B: a lead of 0. As in the
 * agent, the measured delay decides; the start value is 1.
 */
export const MIN_LEAD_BLOCKS = 0;
/**
 * A ceiling for a broken sample, not a target: a phone on a slow link (anvil with 300 ms per
 * round trip measured 6.5 blocks from the send head to the landing) must be able to learn its lead.
 */
export const MAX_LEAD_BLOCKS = 12;
export const INITIAL_LEAD_BLOCKS = 1;
/** Recent landings the lead is averaged over (the agent uses 4 too). */
export const LEAD_WINDOW = 4;

/**
 * The first block B with `stepForBlock(startBlock, B) === step` and `B >= head + lead`: the
 * aimed step in the current loop when there is still time, otherwise in the next one.
 */
export function targetBlockFor(startBlock: bigint, head: bigint, step: number, lead: number): bigint {
  if (!Number.isInteger(step) || step < 0 || step >= STEPS) throw new RangeError(`step must be 0..${STEPS - 1}, got ${step}`);
  const earliest = head + BigInt(Math.max(0, lead));
  const gap = (step - stepForBlock(startBlock, earliest) + STEPS) % STEPS;
  return earliest + BigInt(gap);
}

/** Signed distance from the aimed step to the landed one, the short way round the loop (−7..8). */
export function stepDelta(aimed: number, landed: number): number {
  const d = (((landed - aimed) % STEPS) + STEPS) % STEPS;
  return d > STEPS / 2 ? d - STEPS : d;
}

export interface AimOutcome {
  delta: number;
  text: string;
}

/** The honest result line: "aimed step 7 · landed step 8 (one late)". */
export function aimOutcome(aimed: number, landed: number): AimOutcome {
  const delta = stepDelta(aimed, landed);
  const base = `aimed step ${aimed} · landed step ${landed}`;
  if (delta === 0) return { delta, text: base };
  const n = Math.abs(delta);
  return { delta, text: `${base} (${n === 1 ? 'one' : n} ${delta > 0 ? 'late' : 'early'})` };
}

export interface LeadTracker {
  /** The lead in whole blocks (the rounded mean), for clocks without sub-block timing. */
  lead(): number;
  /** The mean inclusion delay itself, in (fractional) blocks, clamped like the lead. */
  mean(): number;
  /** One landing's inclusion delay in blocks (landed block − head the send fired on). */
  record(inclusionDelay: number): void;
  samples(): readonly number[];
}

export interface LeadTrackerOptions {
  initial?: number;
  window?: number;
  /** The rounded lead changed. */
  onChange?: (lead: number, previous: number) => void;
  /** The mean changed (every landing that moves it; sub-block timing re-times on this). */
  onMeanChange?: (mean: number) => void;
}

export function createLeadTracker(options: LeadTrackerOptions = {}): LeadTracker {
  const window = options.window ?? LEAD_WINDOW;
  let mean = options.initial ?? INITIAL_LEAD_BLOCKS;
  let lead = Math.round(mean);
  const delays: number[] = [];
  return {
    lead: () => lead,
    mean: () => mean,
    samples: () => [...delays],
    record(inclusionDelay) {
      if (!Number.isFinite(inclusionDelay)) return;
      delays.push(Math.max(0, inclusionDelay));
      while (delays.length > window) delays.shift();
      const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
      const nextMean = Math.min(MAX_LEAD_BLOCKS, Math.max(MIN_LEAD_BLOCKS, avg));
      const nextLead = Math.round(nextMean);
      const previous = lead;
      const meanMoved = nextMean !== mean;
      mean = nextMean;
      lead = nextLead;
      if (nextLead !== previous) options.onChange?.(nextLead, previous);
      if (meanMoved) options.onMeanChange?.(nextMean);
    },
  };
}
