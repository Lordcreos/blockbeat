/**
 * W21b: the tips a screen lists: the live `Tipped` events this tab saw and the notes the
 * server holds (every app tip posts one, with or without text), merged by tx hash. Newest
 * first: live tips no note covers yet are the newest (a note follows its tip), then the notes
 * in the server's order. The amount comes from the chain event when this tab saw it.
 */
import type { Address, Hash } from 'viem';
import type { TipEvent } from '../types';
import type { TipNote } from './noteShape';

export interface TipLine {
  txHash: Hash;
  from: Address;
  amountWei: bigint;
  name: string | null;
  message: string | null;
  /** Server receive time of the note (epoch ms); null for a tip without a note yet. */
  at: number | null;
}

export function mergeTips(live: readonly TipEvent[], notes: readonly TipNote[], limit = Infinity): TipLine[] {
  const byHash = new Map<string, TipEvent>();
  for (const t of live) byHash.set(t.txHash.toLowerCase(), t);
  const noted = new Set<string>();
  const fromNotes: TipLine[] = notes.map((n) => {
    const key = n.txHash.toLowerCase();
    noted.add(key);
    const event = byHash.get(key);
    return { txHash: n.txHash, from: event?.from ?? n.from, amountWei: event?.amountWei ?? BigInt(n.amountWei), name: n.name, message: n.message, at: n.createdAt };
  });
  const fresh: TipLine[] = [];
  for (let i = live.length - 1; i >= 0; i--) {
    const t = live[i];
    if (!t || noted.has(t.txHash.toLowerCase())) continue;
    fresh.push({ txHash: t.txHash, from: t.from, amountWei: t.amountWei, name: null, message: null, at: null });
  }
  return [...fresh, ...fromNotes].slice(0, limit);
}

/** Total of the listed tips (the mock track page, where no chain total exists). */
export function sumTips(lines: readonly TipLine[]): bigint {
  return lines.reduce((sum, l) => sum + l.amountWei, 0n);
}
