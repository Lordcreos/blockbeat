/**
 * Burner funding estimates (W12): how many notes a balance still buys, when a phone counts
 * as almost out, and when it may ask the drip for a top-up. Pure, shared by the join page
 * and the drip service.
 *
 * Monad charges the gas LIMIT at the effective price, base fee (100 gwei) plus the fixed 2 gwei
 * tip, so a hit costs its tier times 102 gwei (measured on testnet: a 0.05 MON burner held
 * 0.0296 after its first 200k hit). The node only accepts a transaction whose sender holds
 * `gas × maxFeePerGas`, so the last note needs 0.015 MON on hand (100k × 150 gwei).
 */
import { formatEther, parseEther } from 'viem';
import { HIT_GAS_LIMIT, HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, MONAD_BASE_FEE_WEI } from '@blockbeat/shared';

/** At this many notes left (or fewer) the phone shows "Almost out of MON" and offers a top-up. */
export const ALMOST_OUT_NOTES = 2;
/** The drip tops a burner up only when its balance is below this. */
export const TOP_UP_BELOW_WEI = parseEther('0.03');
/** Top-ups per address per server lifetime (the first drip does not count). */
export const MAX_TOP_UPS_PER_ADDRESS = 2;

export type FundsLevel = 'ok' | 'low' | 'out';

/** What each unit of a hit's gas limit is charged: the base fee plus the hit's fixed tip. */
export const HIT_CHARGED_GAS_PRICE_WEI = MONAD_BASE_FEE_WEI + HIT_MAX_PRIORITY_FEE_PER_GAS;

/** What a hit with this gas limit is charged. */
export function hitCostWei(gas: bigint): bigint {
  return gas * HIT_CHARGED_GAS_PRICE_WEI;
}

/** What the sender must hold for the node to accept a hit with this gas limit. */
function hitRequiredWei(gas: bigint): bigint {
  return gas * HIT_MAX_FEE_PER_GAS;
}

/**
 * Notes this balance still buys when the next hit carries `nextGas` (the first-hit tier until
 * a hit in the session is confirmed) and every later one HIT_GAS_LIMIT.
 */
export function notesLeft(balanceWei: bigint, nextGas: bigint): number {
  if (balanceWei < hitRequiredWei(nextGas)) return 0;
  const afterFirst = balanceWei - hitCostWei(nextGas);
  const needLater = hitRequiredWei(HIT_GAS_LIMIT);
  if (afterFirst < needLater) return 1;
  return 2 + Number((afterFirst - needLater) / hitCostWei(HIT_GAS_LIMIT));
}

export function fundsLevel(notes: number): FundsLevel {
  if (notes <= 0) return 'out';
  return notes <= ALMOST_OUT_NOTES ? 'low' : 'ok';
}

export function isTopUpEligibleBalance(balanceWei: bigint): boolean {
  return balanceWei < TOP_UP_BELOW_WEI;
}

/** MON with at most three decimals, rounded down (a balance is never shown larger than it is). */
export function formatMon(wei: bigint): string {
  const milli = wei / 10n ** 15n;
  return formatEther(milli * 10n ** 15n);
}
