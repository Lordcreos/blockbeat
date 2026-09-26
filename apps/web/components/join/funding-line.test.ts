import { describe, expect, it } from 'vitest';
import { fundingLine, topUpMessage } from './funding-line';

describe('fundingLine (W12)', () => {
  it('is empty when nothing is funding', () => {
    expect(fundingLine(null, 'drip', 0)).toBeNull();
  });

  it('names the step and counts the settle wait down in whole seconds', () => {
    expect(fundingLine({ kind: 'requesting' }, 'drip', 0)).toBe('Funding your wallet…');
    expect(fundingLine({ kind: 'requesting' }, 'topUp', 0)).toBe('Topping up…');
    expect(fundingLine({ kind: 'settling', until: 1_800 }, 'drip', 0)).toBe('Funding your wallet · 2 s');
    expect(fundingLine({ kind: 'settling', until: 1_800 }, 'topUp', 900)).toBe('Topping up · 1 s');
    // Past the estimate the line keeps saying 1 s rather than 0 or a negative number.
    expect(fundingLine({ kind: 'settling', until: 1_800 }, 'topUp', 5_000)).toBe('Topping up · 1 s');
  });

  it('shows the rate-limit retry countdown the same way for both', () => {
    expect(fundingLine({ kind: 'retrying', seconds: 4 }, 'drip', 0)).toBe('Drip busy · retrying in 4 s');
    expect(fundingLine({ kind: 'retrying', seconds: 4 }, 'topUp', 0)).toBe('Drip busy · retrying in 4 s');
  });
});

describe('topUpMessage (W12)', () => {
  it('turns refusal codes into short phone lines, never the raw server text', () => {
    expect(topUpMessage('BALANCE_NOT_LOW')).toBe('Top up opens below 0.03 MON');
    expect(topUpMessage('TOPUP_LIMIT_REACHED')).toBe('No top-ups left for this wallet');
    expect(topUpMessage('NOT_FUNDED_YET')).toBe('This wallet cannot be topped up here');
    expect(topUpMessage('RATE_LIMITED')).toBe('Drip busy, try again in a minute');
    expect(topUpMessage('DRIP_FAILED')).toBe('Top up failed, try again');
    expect(topUpMessage('BALANCE_UNAVAILABLE')).toBe('Top up failed, try again');
  });
});
