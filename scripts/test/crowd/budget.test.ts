import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { HITS_PER_DRIP_ESTIMATE, HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, HIT_MAX_FEE_PER_GAS } from '@blockbeat/shared';
import { CHARGED_GAS_PRICE_WEI, checkBudget, fundWeiFor, notesPerPlayerFor, projectCost } from '../../src/lib/crowd/budget';
import { planCrowd } from '../../src/lib/crowd/persona';
import { TRANSFER_GAS } from '../../src/lib/runner';

describe('crowd budget (W19)', () => {
  it('charges the gas LIMIT at base fee + tip: 0.0204 MON for a first hit, 0.0102 after', () => {
    expect(CHARGED_GAS_PRICE_WEI).toBe(102_000_000_000n);
    expect(HIT_GAS_LIMIT_FIRST * CHARGED_GAS_PRICE_WEI).toBe(parseEther('0.0204'));
    expect(HIT_GAS_LIMIT * CHARGED_GAS_PRICE_WEI).toBe(parseEther('0.0102'));
  });

  it('funds a player for its notes at the max fee plus its sweep, with 5 % headroom', () => {
    const need = (HIT_GAS_LIMIT_FIRST + 2n * HIT_GAS_LIMIT + TRANSFER_GAS) * HIT_MAX_FEE_PER_GAS;
    expect(fundWeiFor(3)).toBe((need * 105n) / 100n);
    expect(fundWeiFor(0)).toBe(0n);
  });

  it('projects the whole run from the plan: hits (one first-tier hit per player), funding and sweep transfers', () => {
    const plan = planCrowd({ seed: 7, players: 4, bars: 20, notesPerPlayer: 5 });
    const p = projectCost(plan);
    const perPlayer = plan.personas.map((persona) => plan.notes.filter((n) => n.player === persona.id).length);
    const funded = perPlayer.filter((n) => n > 0).length;
    expect(p.notes).toBe(plan.notes.length);
    expect(p.players).toBe(funded);
    expect(p.hitsWei).toBe((BigInt(funded) * HIT_GAS_LIMIT_FIRST + BigInt(p.notes - funded) * HIT_GAS_LIMIT) * CHARGED_GAS_PRICE_WEI);
    expect(p.transfersWei).toBe(BigInt(2 * funded) * TRANSFER_GAS * CHARGED_GAS_PRICE_WEI);
    expect(p.totalWei).toBe(p.hitsWei + p.transfersWei);
    expect(p.fundWei).toEqual(perPlayer.map((n) => fundWeiFor(n)));
    expect(p.lockedWei).toBe(p.fundWei.reduce((a, b) => a + b, 0n));
  });

  it('the automatic allowance keeps the projected cost within --max-mon, capped at a drip', () => {
    for (const [players, maxMon, bars] of [[10, '1.5', 38], [10, '1.0', 25], [3, '0.2', 12], [30, '1.5', 38], [2, '5', 60]] as const) {
      const n = notesPerPlayerFor(parseEther(maxMon), players);
      expect(n).toBeLessThanOrEqual(HITS_PER_DRIP_ESTIMATE);
      const plan = planCrowd({ seed: 1, players, bars, notesPerPlayer: n });
      expect(projectCost(plan).totalWei, `${players} players, ${maxMon} MON`).toBeLessThanOrEqual(parseEther(maxMon));
    }
    expect(notesPerPlayerFor(parseEther('1.5'), 10)).toBe(13);
    expect(notesPerPlayerFor(parseEther('0.001'), 10)).toBe(0);
  });

  it('refuses a projection above the budget or above what the funder holds', () => {
    const plan = planCrowd({ seed: 7, players: 10, bars: 38, notesPerPlayer: 28 });
    const p = projectCost(plan);
    const over = checkBudget(p, { maxWei: p.totalWei - 1n, funderBalanceWei: parseEther('100') });
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.reason).toMatch(/exceeds --max-mon/);
    const poor = checkBudget(p, { maxWei: parseEther('100'), funderBalanceWei: p.lockedWei });
    expect(poor.ok).toBe(false);
    expect(poor.ok ? '' : poor.reason).toMatch(/funder holds/);
    expect(checkBudget(p, { maxWei: p.totalWei, funderBalanceWei: p.lockedWei + parseEther('1') }).ok).toBe(true);
    const empty = projectCost(planCrowd({ seed: 7, players: 2, bars: 4, notesPerPlayer: 0 }));
    const none = checkBudget(empty, { maxWei: parseEther('1'), funderBalanceWei: parseEther('1') });
    expect(none.ok ? '' : none.reason).toMatch(/no notes/);
  });
});
