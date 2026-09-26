/**
 * Predicts, at send time, which block (and therefore which step) a hit will land in, and
 * classifies the actual landing against that prediction. Mirrors the contract:
 * step = (block - startBlock) % 16 (shared `stepForBlock`).
 */
import { STEPS, stepForBlock } from '@blockbeat/shared';

export interface PredictionInput {
  startBlock: bigint;
  /** Latest head we have seen. */
  head: bigint;
  /** Wall-clock ms when that head was seen. */
  headSeenAt: number;
  /** Wall-clock ms now (send time). */
  now: number;
  /** Block cadence in ms (nominal 300 on Monad, measured when available). */
  blockMs: number;
  /**
   * Extra blocks between "next block" and the one the tx is expected to land in. A tx
   * sent while block N+1 is being built typically lands in N+2 on Monad (lag 1). Anvil
   * with instant mining includes it in the very next block (lag 0).
   */
  lagBlocks: number;
}

export interface Prediction {
  block: bigint;
  step: number;
}

export function predictLanding(input: PredictionInput): Prediction {
  const { startBlock, head, headSeenAt, now, blockMs, lagBlocks } = input;
  if (now < headSeenAt) throw new Error(`now (${now}) is before headSeenAt (${headSeenAt})`);
  if (!(blockMs > 0)) throw new Error(`blockMs must be positive, got ${blockMs}`);
  if (lagBlocks < 0 || !Number.isInteger(lagBlocks)) throw new Error(`lagBlocks must be a non-negative integer, got ${lagBlocks}`);
  const elapsedBlocks = Math.floor((now - headSeenAt) / blockMs);
  const block = head + BigInt(elapsedBlocks) + 1n + BigInt(lagBlocks);
  return { block, step: stepForBlock(startBlock, block) };
}

function assertStep(name: string, step: number): void {
  if (!Number.isInteger(step) || step < 0 || step >= STEPS) throw new Error(`${name} step must be 0..${STEPS - 1}, got ${step}`);
}

/**
 * Signed distance from the intended to the actual step on the 16-step ring, in
 * -7..8. Positive means late.
 */
export function stepDelta(intended: number, actual: number): number {
  assertStep('intended', intended);
  assertStep('actual', actual);
  const d = (actual - intended + STEPS) % STEPS;
  return d > STEPS / 2 ? d - STEPS : d;
}

export type Landing = 'on-time' | 'one-late' | 'late' | 'early';

export function classifyLanding(intended: number, actual: number): Landing {
  const d = stepDelta(intended, actual);
  if (d === 0) return 'on-time';
  if (d === 1) return 'one-late';
  return d > 1 ? 'late' : 'early';
}
