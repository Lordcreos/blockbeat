import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST } from '@blockbeat/shared';
import { ALMOST_OUT_NOTES, TOP_UP_BELOW_WEI, formatMon, fundsLevel, hitCostWei, isTopUpEligibleBalance, notesLeft } from './funding';

describe('funding estimates (W12)', () => {
  it('charges the gas limit at the 100 gwei base fee plus the 2 gwei tip (measured on testnet, W12)', () => {
    // A 0.05 MON burner held 0.0296 after its first 200k hit: 200k x 102 gwei = 0.0204.
    expect(hitCostWei(HIT_GAS_LIMIT_FIRST)).toBe(parseEther('0.0204'));
    expect(hitCostWei(HIT_GAS_LIMIT)).toBe(parseEther('0.0102'));
  });

  it('turns a fresh 0.3 MON drip into about 27 notes (first hit on the 200k tier)', () => {
    expect(notesLeft(parseEther('0.3'), HIT_GAS_LIMIT_FIRST)).toBe(27);
    expect(notesLeft(parseEther('0.3'), HIT_GAS_LIMIT)).toBe(28);
  });

  it('keeps the rehearsal case honest: 0.0296 MON after a first hit still buys a note on the 100k tier', () => {
    expect(notesLeft(parseEther('0.0296'), HIT_GAS_LIMIT)).toBe(2);
    expect(notesLeft(parseEther('0.0296'), HIT_GAS_LIMIT_FIRST)).toBe(0);
  });

  it('needs the full max fee in the wallet for the last note, not just its charge', () => {
    // 100k gas at the 150 gwei max fee: the node wants 0.015 MON on hand for a 0.01 MON note.
    expect(notesLeft(parseEther('0.015'), HIT_GAS_LIMIT)).toBe(1);
    expect(notesLeft(parseEther('0.0149'), HIT_GAS_LIMIT)).toBe(0);
    expect(notesLeft(parseEther('0.0252'), HIT_GAS_LIMIT)).toBe(2);
    expect(notesLeft(parseEther('0.025'), HIT_GAS_LIMIT)).toBe(1);
    expect(notesLeft(parseEther('0.029'), HIT_GAS_LIMIT_FIRST)).toBe(0);
  });

  it('says zero for the rehearsal burner that ran dry at 0.0042 MON', () => {
    expect(notesLeft(parseEther('0.0042'), HIT_GAS_LIMIT)).toBe(0);
    expect(notesLeft(0n, HIT_GAS_LIMIT)).toBe(0);
  });

  it('classifies ok, almost out (2 or fewer) and out', () => {
    expect(ALMOST_OUT_NOTES).toBe(2);
    expect(fundsLevel(0)).toBe('out');
    expect(fundsLevel(1)).toBe('low');
    expect(fundsLevel(2)).toBe('low');
    expect(fundsLevel(3)).toBe('ok');
  });

  it('allows a top-up only below 0.03 MON', () => {
    expect(TOP_UP_BELOW_WEI).toBe(parseEther('0.03'));
    expect(isTopUpEligibleBalance(parseEther('0.0299'))).toBe(true);
    expect(isTopUpEligibleBalance(parseEther('0.03'))).toBe(false);
  });

  it('formats MON with at most three decimals, rounding down so it never overstates', () => {
    expect(formatMon(parseEther('0.2149'))).toBe('0.214');
    expect(formatMon(parseEther('0.0042'))).toBe('0.004');
    expect(formatMon(parseEther('0.3'))).toBe('0.3');
    expect(formatMon(parseEther('1.5'))).toBe('1.5');
    expect(formatMon(parseEther('0.015'))).toBe('0.015');
    expect(formatMon(0n)).toBe('0');
    expect(formatMon(parseEther('0.0004'))).toBe('0');
  });
});
