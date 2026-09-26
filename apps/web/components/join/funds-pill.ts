import { formatMon, fundsLevel } from '@/lib/funding';

export type PillTone = 'ok' | 'muted' | 'warn' | 'danger';

export interface FundsPillInput {
  error: boolean;
  finalized: boolean;
  warming: boolean;
  restored: boolean;
  /** A running drip or top-up countdown line ("Topping up · 3 s"); wins over the balance. */
  funding: string | null;
  balanceWei: bigint | null;
  notesLeft: number | null;
  /** A hit was refused for funds: out of MON whatever the estimate says. */
  forcedOut: boolean;
}

/** W12: the header pill on the phone. Balance and notes left once known, a clear warning at 2 or fewer. */
export function fundsPill(input: FundsPillInput): { text: string; tone: PillTone } {
  if (input.error) return { text: 'Drip failed', tone: 'danger' };
  if (input.finalized) return { text: 'Track minted', tone: 'muted' };
  if (input.warming) return { text: input.funding ?? 'Funding your wallet…', tone: 'muted' };
  if (input.funding) return { text: input.funding, tone: 'warn' };
  if (input.forcedOut) return { text: 'Out of MON', tone: 'danger' };
  if (input.balanceWei === null || input.notesLeft === null) {
    return { text: input.restored ? 'Wallet restored' : 'Wallet ready', tone: 'muted' };
  }
  const level = fundsLevel(input.notesLeft);
  if (level === 'out') return { text: 'Out of MON', tone: 'danger' };
  if (level === 'low') return { text: `Almost out of MON · ${input.notesLeft} ${input.notesLeft === 1 ? 'note' : 'notes'} left`, tone: 'warn' };
  return { text: `${formatMon(input.balanceWei)} MON · ~${input.notesLeft} notes`, tone: 'ok' };
}
