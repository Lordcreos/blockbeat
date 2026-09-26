/**
 * W21b: tip page product constants (not contract interface). Five fixed amounts, no free
 * amount; the tipper burner is funded once by the drip with TIPPER_DRIP_MON, enough for one
 * 0.05 MON tip and a second, smaller one at the fixed tip gas limit and fees.
 */
import { parseEther } from 'viem';
import { HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, MONAD_BASE_FEE_WEI, TIP_GAS_LIMIT } from '@blockbeat/shared';

export const TIP_AMOUNTS_MON = ['0.01', '0.02', '0.03', '0.04', '0.05'] as const;
export type TipAmountMon = (typeof TIP_AMOUNTS_MON)[number];
export const DEFAULT_TIP_MON: TipAmountMon = '0.01';

/** Optional note limits, in characters (code points), enforced on the phone and the server. */
export const NOTE_NAME_MAX = 24;
export const NOTE_MESSAGE_MAX = 140;

/** What the drip sends a tipper burner (drip route, `mode: "tipper"`); TIP_DRIP_AMOUNT_MON overrides it on the server. */
export const TIPPER_DRIP_MON = '0.1';

export function isTipAmount(value: string): value is TipAmountMon {
  return (TIP_AMOUNTS_MON as readonly string[]).includes(value);
}

/** What the node wants the sender to hold for a tip of `valueWei` (gas limit × max fee + value). */
export function tipRequiredWei(valueWei: bigint): bigint {
  return valueWei + TIP_GAS_LIMIT * HIT_MAX_FEE_PER_GAS;
}

/** What a tip of `valueWei` costs the sender: Monad charges the gas limit at base fee + tip. */
export function tipChargedWei(valueWei: bigint): bigint {
  return valueWei + TIP_GAS_LIMIT * (MONAD_BASE_FEE_WEI + HIT_MAX_PRIORITY_FEE_PER_GAS);
}

/** The largest of `amounts` this balance still sends, or null when it pays for none. */
export function affordableTip<T extends string>(balanceWei: bigint, amounts: readonly T[]): T | null {
  let best: T | null = null;
  for (const amount of amounts) {
    if (balanceWei >= tipRequiredWei(parseEther(amount))) best = amount;
  }
  return best;
}
