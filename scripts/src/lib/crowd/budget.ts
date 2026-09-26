/**
 * W19: what a crowd run costs, priced from its plan before any MON moves.
 *
 * Monad charges the gas LIMIT at the effective price (base fee + tip), so a hit's cost is
 * known exactly: the fixed tiers from `@blockbeat/shared` at 102 gwei. Every player's first
 * hit (nonce order: it always executes first) pays the 200k tier, the rest 100k. Each funded
 * player also costs one funding transfer and one sweep transfer. Funding reserves the max fee
 * (the node checks balance against gas limit × max fee), and the sweep returns the rest.
 */
import { formatEther } from 'viem';
import { HITS_PER_DRIP_ESTIMATE, HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, MONAD_BASE_FEE_WEI } from '@blockbeat/shared';
import { TRANSFER_GAS } from '../runner';
import type { CrowdPlan } from './persona';

/** What a transaction is charged per unit of its gas limit on Monad testnet. */
export const CHARGED_GAS_PRICE_WEI = MONAD_BASE_FEE_WEI + HIT_MAX_PRIORITY_FEE_PER_GAS;
const HEADROOM_PERCENT = 105n;

/** MON a burner needs for `notes` hits at the max fee plus its sweep, with 5 % headroom; 0 for no notes. */
export function fundWeiFor(notes: number): bigint {
  if (notes <= 0) return 0n;
  const gas = HIT_GAS_LIMIT_FIRST + BigInt(notes - 1) * HIT_GAS_LIMIT + TRANSFER_GAS;
  return (gas * HIT_MAX_FEE_PER_GAS * HEADROOM_PERCENT) / 100n;
}

/**
 * The largest per-player allowance whose worst case (every player plays all of it) stays
 * within `maxWei`, capped at a phone's drip (HITS_PER_DRIP_ESTIMATE).
 */
export function notesPerPlayerFor(maxWei: bigint, players: number): number {
  if (players < 1) return 0;
  const overhead = (2n * TRANSFER_GAS + HIT_GAS_LIMIT_FIRST - HIT_GAS_LIMIT) * CHARGED_GAS_PRICE_WEI;
  const share = maxWei / BigInt(players) - overhead;
  if (share <= 0n) return 0;
  return Math.min(HITS_PER_DRIP_ESTIMATE, Number(share / (HIT_GAS_LIMIT * CHARGED_GAS_PRICE_WEI)));
}

export interface Projection {
  /** Planned notes (an upper bound: live cells and late sends only remove notes). */
  notes: number;
  /** Players with at least one note: the ones that get funded. */
  players: number;
  hitsWei: bigint;
  /** Funding plus sweep transfers. */
  transfersWei: bigint;
  /** What the run spends at most: hits and transfers. */
  totalWei: bigint;
  /** Per persona (index = persona id), 0 for a player with no notes. */
  fundWei: bigint[];
  /** MON parked in burners during the run; the sweep returns what the hits did not spend. */
  lockedWei: bigint;
  /** What the funder must hold: the locked MON plus the funding transfers at the max fee. */
  funderNeedsWei: bigint;
}

export function projectCost(plan: CrowdPlan): Projection {
  const counts = plan.personas.map((p) => plan.notes.filter((n) => n.player === p.id).length);
  const players = counts.filter((n) => n > 0).length;
  const notes = counts.reduce((a, b) => a + b, 0);
  const hitsWei = (BigInt(players) * HIT_GAS_LIMIT_FIRST + BigInt(notes - players) * HIT_GAS_LIMIT) * CHARGED_GAS_PRICE_WEI;
  const transfersWei = BigInt(2 * players) * TRANSFER_GAS * CHARGED_GAS_PRICE_WEI;
  const fundWei = counts.map((n) => fundWeiFor(n));
  const lockedWei = fundWei.reduce((a, b) => a + b, 0n);
  return {
    notes,
    players,
    hitsWei,
    transfersWei,
    totalWei: hitsWei + transfersWei,
    fundWei,
    lockedWei,
    funderNeedsWei: lockedWei + BigInt(players) * TRANSFER_GAS * HIT_MAX_FEE_PER_GAS,
  };
}

export type BudgetCheck = { ok: true } | { ok: false; reason: string };

export function checkBudget(p: Projection, limits: { maxWei: bigint; funderBalanceWei: bigint }): BudgetCheck {
  if (p.notes === 0) return { ok: false, reason: 'the plan has no notes: raise --max-mon or --minutes, or lower --players' };
  if (p.totalWei > limits.maxWei) return { ok: false, reason: `projected cost ${formatEther(p.totalWei)} MON exceeds --max-mon ${formatEther(limits.maxWei)}` };
  if (p.funderNeedsWei > limits.funderBalanceWei) {
    return { ok: false, reason: `the funder holds ${formatEther(limits.funderBalanceWei)} MON but funding needs ${formatEther(p.funderNeedsWei)} MON` };
  }
  return { ok: true };
}

/** One printable line for the log, before any funding. */
export function describeProjection(p: Projection, maxWei: bigint): string {
  return `projected: ${p.notes} notes by ${p.players} players ≤ ${formatEther(p.totalWei)} MON (hits ${formatEther(p.hitsWei)}, transfers ${formatEther(p.transfersWei)}; budget ${formatEther(maxWei)}); ${formatEther(p.lockedWei)} MON parked in burners and swept back`;
}
