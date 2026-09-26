import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { fundsPill } from './funds-pill';

const base = { error: false, finalized: false, warming: false, restored: false, funding: null, balanceWei: null, notesLeft: null, forcedOut: false } as const;

describe('fundsPill (W12)', () => {
  it('shows the balance and an estimate of notes left once the wallet is ready', () => {
    expect(fundsPill({ ...base, balanceWei: parseEther('0.2149'), notesLeft: 21 })).toEqual({ text: '0.214 MON · ~21 notes', tone: 'ok' });
    expect(fundsPill({ ...base, balanceWei: parseEther('0.3'), notesLeft: 1 }).text).toBe('Almost out of MON · 1 note left');
  });

  it('says almost out at two notes or fewer, and out at zero', () => {
    expect(fundsPill({ ...base, balanceWei: parseEther('0.03'), notesLeft: 2 })).toEqual({ text: 'Almost out of MON · 2 notes left', tone: 'warn' });
    expect(fundsPill({ ...base, balanceWei: parseEther('0.0042'), notesLeft: 0 })).toEqual({ text: 'Out of MON', tone: 'danger' });
  });

  it('shows out of MON when a hit was refused for funds even if the estimate disagrees', () => {
    expect(fundsPill({ ...base, balanceWei: parseEther('0.016'), notesLeft: 1, forcedOut: true }).text).toBe('Out of MON');
  });

  it('falls back to the wallet status before the first balance read', () => {
    expect(fundsPill(base)).toEqual({ text: 'Wallet ready', tone: 'muted' });
    expect(fundsPill({ ...base, restored: true }).text).toBe('Wallet restored');
    expect(fundsPill({ ...base, warming: true }).text).toBe('Funding your wallet…');
    expect(fundsPill({ ...base, warming: true, funding: 'Funding your wallet · 2 s' }).text).toBe('Funding your wallet · 2 s');
    expect(fundsPill({ ...base, error: true })).toEqual({ text: 'Drip failed', tone: 'danger' });
    expect(fundsPill({ ...base, finalized: true, balanceWei: 1n, notesLeft: 0 }).text).toBe('Track minted');
  });

  it('shows a top-up in progress over the balance', () => {
    expect(fundsPill({ ...base, balanceWei: parseEther('0.01'), notesLeft: 0, funding: 'Topping up · 3 s' })).toEqual({ text: 'Topping up · 3 s', tone: 'warn' });
  });
});
