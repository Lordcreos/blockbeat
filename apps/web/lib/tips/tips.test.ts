import { describe, expect, it } from 'vitest';
import { parseEther, type Address } from 'viem';
import { MONAD_BASE_FEE_WEI, HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, TIP_GAS_LIMIT } from '@blockbeat/shared';
import { DEFAULT_TIP_MON, TIPPER_DRIP_MON, TIP_AMOUNTS_MON, affordableTip, tipChargedWei, tipRequiredWei } from './constants';
import { HOST_TIP_BPS } from '@blockbeat/shared';
import { splitTip, trackSplit } from './split';

const HUMAN_A = '0x00000000000000000000000000000000000000a1' as Address;
const HUMAN_B = '0x00000000000000000000000000000000000000b2' as Address;
const DJ = '0x00000000000000000000000000000000000000d3' as Address;

describe('tip amounts (W21b)', () => {
  it('offers five fixed amounts from 0.01 to 0.05 MON and defaults to the smallest', () => {
    expect(TIP_AMOUNTS_MON).toEqual(['0.01', '0.02', '0.03', '0.04', '0.05']);
    expect(DEFAULT_TIP_MON).toBe('0.01');
  });

  it('prices a tip at its value plus the fixed tip gas limit at the fixed fees', () => {
    const value = parseEther('0.02');
    expect(tipRequiredWei(value)).toBe(value + TIP_GAS_LIMIT * HIT_MAX_FEE_PER_GAS);
    expect(tipChargedWei(value)).toBe(value + TIP_GAS_LIMIT * (MONAD_BASE_FEE_WEI + HIT_MAX_PRIORITY_FEE_PER_GAS));
  });

  it('funds a tipper with enough for one 0.05 tip and a second one after it (TIP_GAS_LIMIT 120k since W21a)', () => {
    expect(TIP_GAS_LIMIT).toBe(120_000n);
    const drip = parseEther(TIPPER_DRIP_MON);
    const top = parseEther('0.05');
    expect(drip).toBeGreaterThanOrEqual(tipRequiredWei(top));
    const after = drip - tipChargedWei(top);
    expect(affordableTip(after, TIP_AMOUNTS_MON)).not.toBeNull();
  });

  it('affordableTip picks the largest amount the balance still pays for, or null', () => {
    expect(affordableTip(parseEther('1'), TIP_AMOUNTS_MON)).toBe('0.05');
    expect(affordableTip(tipRequiredWei(parseEther('0.03')), TIP_AMOUNTS_MON)).toBe('0.03');
    expect(affordableTip(tipRequiredWei(parseEther('0.01')) - 1n, TIP_AMOUNTS_MON)).toBeNull();
  });
});

describe('splitTip: 20 % to the host, 80 % to the players (W21a semantics)', () => {
  it('uses the contract share', () => {
    expect(HOST_TIP_BPS).toBe(2_000n);
  });

  it('sends the host share and pools the rest once a human has played', () => {
    const { hostWei, poolWei } = splitTip(parseEther('0.02'), 3n);
    expect(hostWei).toBe(parseEther('0.004'));
    expect(poolWei).toBe(parseEther('0.016'));
  });

  it('gives the whole tip to the host while only the DJ has played', () => {
    expect(splitTip(parseEther('0.05'), 0n)).toEqual({ hostWei: parseEther('0.05'), poolWei: 0n });
  });

  it('never loses a wei to rounding', () => {
    const { hostWei, poolWei } = splitTip(7n, 1n);
    expect(hostWei + poolWei).toBe(7n);
  });
});

describe('trackSplit: per-player earnings from the pool (W21b track page)', () => {
  it('splits the pool pro rata among humans by hits; the DJ keeps its notes and earns nothing', () => {
    const view = trackSplit({
      hostWei: parseEther('0.004'),
      poolWei: parseEther('0.016'),
      contributors: [
        { address: HUMAN_A, hits: 3n },
        { address: DJ, hits: 4n },
        { address: HUMAN_B, hits: 1n },
      ],
      agent: DJ,
    });
    expect(view.raisedWei).toBe(parseEther('0.02'));
    expect(view.humanHits).toBe(4n);
    const a = view.rows.find((r) => r.address === HUMAN_A);
    const b = view.rows.find((r) => r.address === HUMAN_B);
    const dj = view.rows.find((r) => r.address === DJ);
    expect(a).toMatchObject({ hits: 3n, isAgent: false, sharePct: 75, earnedWei: parseEther('0.012') });
    expect(b).toMatchObject({ hits: 1n, isAgent: false, sharePct: 25, earnedWei: parseEther('0.004') });
    expect(dj).toMatchObject({ hits: 4n, isAgent: true, sharePct: null, earnedWei: 0n });
  });

  it('matches the agent address case-insensitively and works without a DJ', () => {
    const lower = trackSplit({ hostWei: 0n, poolWei: 10n, contributors: [{ address: DJ, hits: 1n }], agent: DJ.toUpperCase().replace('0X', '0x') as Address });
    expect(lower.rows[0]?.isAgent).toBe(true);
    const none = trackSplit({ hostWei: 0n, poolWei: 10n, contributors: [{ address: HUMAN_A, hits: 2n }], agent: null });
    expect(none.rows[0]).toMatchObject({ sharePct: 100, earnedWei: 10n });
  });

  it('keeps the order humans by hits first and the DJ last', () => {
    const view = trackSplit({
      hostWei: 0n,
      poolWei: 0n,
      contributors: [
        { address: DJ, hits: 9n },
        { address: HUMAN_B, hits: 1n },
        { address: HUMAN_A, hits: 5n },
      ],
      agent: DJ,
    });
    expect(view.rows.map((r) => r.address)).toEqual([HUMAN_A, HUMAN_B, DJ]);
  });
});
