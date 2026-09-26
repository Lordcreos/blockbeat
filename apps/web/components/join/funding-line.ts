import type { FundingPhase } from '@/lib/hooks';
import { TOP_UP_BELOW_WEI, formatMon } from '@/lib/funding';

const LABEL = { drip: 'Funding your wallet', topUp: 'Topping up' } as const;

/** W12: the countdown line for the first drip and for a top-up, shown in the header pill. */
export function fundingLine(phase: FundingPhase | null, what: keyof typeof LABEL, now: number): string | null {
  if (phase === null) return null;
  if (phase.kind === 'requesting') return `${LABEL[what]}…`;
  if (phase.kind === 'retrying') return `Drip busy · retrying in ${phase.seconds} s`;
  return `${LABEL[what]} · ${Math.max(1, Math.ceil((phase.until - now) / 1000))} s`;
}

/** W12: short phone text for a refused or failed top-up (the server message stays in the console). */
export function topUpMessage(code: string): string {
  switch (code) {
    case 'BALANCE_NOT_LOW':
      return `Top up opens below ${formatMon(TOP_UP_BELOW_WEI)} MON`;
    case 'TOPUP_LIMIT_REACHED':
      return 'No top-ups left for this wallet';
    case 'NOT_FUNDED_YET':
      return 'This wallet cannot be topped up here';
    case 'RATE_LIMITED':
      return 'Drip busy, try again in a minute';
    default:
      return 'Top up failed, try again';
  }
}
