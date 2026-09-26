import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toFunctionSignature, toEventSignature, type AbiEvent, type AbiFunction } from 'viem';
import {
  BPS_DENOMINATOR,
  CLAIM_GAS_LIMIT,
  HOST_CLAIM_GAS_LIMIT,
  HOST_TIP_BPS,
  RESIDENT_DJ_ADDRESS,
  TIP_GAS_LIMIT,
  blockbeatAddress,
  blockbeatAbi,
  playerShare,
  residentDjAddress,
  splitTip,
  ZERO_ADDRESS,
  MONAD_TESTNET_ID,
} from './index';

describe('splitTip mirrors Blockbeat.tip (W21a)', () => {
  it('sends 20 % to the host and 80 % to the players pool', () => {
    expect(HOST_TIP_BPS).toBe(2000n);
    expect(BPS_DENOMINATOR).toBe(10_000n);
    expect(splitTip(1_000_000_000_000_000_000n, 3n)).toEqual({
      hostAmount: 200_000_000_000_000_000n,
      poolAmount: 800_000_000_000_000_000n,
    });
  });

  it('floors the host share so the pool gets the odd wei and no wei is lost', () => {
    expect(splitTip(7n, 1n)).toEqual({ hostAmount: 1n, poolAmount: 6n });
    expect(splitTip(1n, 1n)).toEqual({ hostAmount: 0n, poolAmount: 1n });
  });

  it('gives the whole tip to the host while only the resident DJ has played', () => {
    expect(splitTip(5n, 0n)).toEqual({ hostAmount: 5n, poolAmount: 0n });
  });

  it('rejects a negative amount or hit count', () => {
    expect(() => splitTip(-1n, 1n)).toThrow(RangeError);
    expect(() => splitTip(1n, -1n)).toThrow(RangeError);
  });
});

describe('playerShare mirrors Blockbeat.claimableOf (before subtracting claims)', () => {
  it('is tipPool * playerHits / humanHitCount, floored', () => {
    expect(playerShare(4n, 3n, 4n)).toBe(3n);
    expect(playerShare(10n, 1n, 3n)).toBe(3n);
  });

  it('is 0 with no hits or no humans', () => {
    expect(playerShare(10n, 0n, 3n)).toBe(0n);
    expect(playerShare(10n, 0n, 0n)).toBe(0n);
  });
});

describe('resident DJ address', () => {
  it('is the testnet agent wallet on 10143 and zero on unknown chains', () => {
    expect(RESIDENT_DJ_ADDRESS[MONAD_TESTNET_ID]).toBe('0x2222222222222222222222222222222222222222');
    expect(residentDjAddress(MONAD_TESTNET_ID)).toBe('0x2222222222222222222222222222222222222222');
    expect(residentDjAddress(424242)).toBe(ZERO_ADDRESS);
  });

  it('matches the default baked into contracts/script/Deploy.s.sol (no drift)', () => {
    const script = readFileSync(resolve(__dirname, '../../../contracts/script/Deploy.s.sol'), 'utf8');
    const match = script.match(/DEFAULT_AGENT = (0x[0-9a-fA-F]{40});/);
    expect(match?.[1]).toBe(RESIDENT_DJ_ADDRESS[MONAD_TESTNET_ID]);
  });
});

describe('W21a ABI additions', () => {
  const fnSigs = blockbeatAbi
    .filter((i) => i.type === 'function')
    .map((f) => toFunctionSignature(f as AbiFunction));
  const eventSigs = blockbeatAbi
    .filter((i) => i.type === 'event')
    .map((e) => toEventSignature(e as AbiEvent));

  it('adds the host claim and the split views', () => {
    for (const sig of [
      'claimHost(uint256)',
      'hostTipsOf(uint256)',
      'hostClaimableOf(uint256)',
      'totalTipsOf(uint256)',
      'humanHitCountOf(uint256)',
      'agent()',
      'HOST_TIP_BPS()',
      'BPS_DENOMINATOR()',
    ]) {
      expect(fnSigs).toContain(sig);
    }
  });

  const indexedOf = (name: string): boolean[] =>
    (blockbeatAbi.find((i) => i.type === 'event' && i.name === name) as AbiEvent).inputs.map((x) => x.indexed === true);

  it('adds TipSplit and HostClaimed and keeps Tipped unchanged', () => {
    expect(eventSigs).toContain('TipSplit(uint256,uint256,uint256)');
    expect(indexedOf('TipSplit')).toEqual([true, false, false]);
    expect(eventSigs).toContain('HostClaimed(uint256,address,uint256)');
    expect(indexedOf('HostClaimed')).toEqual([true, true, false]);
    expect(eventSigs).toContain('Tipped(uint256,address,uint256)');
    expect(indexedOf('Tipped')).toEqual([true, true, false]);
  });

  it('keeps every pre-W21a signature (additions only)', () => {
    for (const sig of [
      'startSession()',
      'remix(uint256)',
      'hit(uint256,uint8,uint8)',
      'tip(uint256)',
      'finalize(uint256)',
      'claim(uint256)',
      'claimableOf(uint256,address)',
      'getSession(uint256)',
      'hitsOf(uint256,address)',
    ]) {
      expect(fnSigs).toContain(sig);
    }
  });

  it('lists the new errors so viem decodes them by name', () => {
    const errors = blockbeatAbi.filter((i) => i.type === 'error').map((e) => e.name);
    expect(errors).toContain('ZeroAgent');
    expect(errors).toContain('SafeCastOverflowedUintDowncast');
  });
});

describe('tip and claim gas limits (fixed, never estimated in the hot path)', () => {
  it('covers the W21a tip (anvil 55,540 first tip, plus Monad cold-access repricing)', () => {
    expect(TIP_GAS_LIMIT).toBe(120_000n);
  });

  it('gives claim and claimHost a fixed limit with headroom (anvil 61,890 / 57,153)', () => {
    expect(CLAIM_GAS_LIMIT).toBe(150_000n);
    expect(HOST_CLAIM_GAS_LIMIT).toBe(150_000n);
  });
});

describe('W21a deployment', () => {
  it('points 10143 at the tip-split contract, not the pre-split one', () => {
    expect(blockbeatAddress(MONAD_TESTNET_ID)).toBe('0x1111111111111111111111111111111111111111');
    expect(blockbeatAddress(MONAD_TESTNET_ID)).not.toBe('0x1111111111111111111111111111111111111111');
  });
});
