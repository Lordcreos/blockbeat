import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { MONAD_RESERVE_BALANCE_WEI, RESERVE_PACING_BLOCKS, RESERVE_WINDOW_BLOCKS, isBelowReserve } from '@blockbeat/shared';

describe('Monad reserve balance (docs.monad.xyz/developer-essentials/reserve-balance)', () => {
  it('is 10 MON with a 3-block emptying window; paced senders wait 5 heads', () => {
    expect(MONAD_RESERVE_BALANCE_WEI).toBe(parseEther('10'));
    expect(RESERVE_WINDOW_BLOCKS).toBe(3);
    // Inclusion can trail the send head by up to 2 blocks, and the next send must land > 3 blocks later.
    expect(RESERVE_PACING_BLOCKS).toBe(5);
  });

  it('flags a value transfer whose sender would end below the reserve', () => {
    expect(isBelowReserve(parseEther('4.4'), parseEther('0.3'))).toBe(true);
    expect(isBelowReserve(parseEther('10.2'), parseEther('0.3'))).toBe(true);
    expect(isBelowReserve(parseEther('10.3'), parseEther('0.3'))).toBe(false);
    expect(isBelowReserve(parseEther('28'), parseEther('0.3'))).toBe(false);
  });
});
