import { describe, expect, it, vi } from 'vitest';
import { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST } from '@blockbeat/shared';
import { HIT_SESSIONS_STORAGE_KEY, createHitGasPolicy } from './hitGas';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

function memoryStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

describe('createHitGasPolicy', () => {
  it('uses the first-hit limit until a hit is confirmed in that session, then the lower one', () => {
    const storage = memoryStorage();
    const policy = createHitGasPolicy({ address: A, chainId: 1, storage });
    expect(policy.gasFor(1n)).toBe(HIT_GAS_LIMIT_FIRST);
    policy.markConfirmed(1n);
    expect(policy.gasFor(1n)).toBe(HIT_GAS_LIMIT);
    expect(policy.gasFor(2n)).toBe(HIT_GAS_LIMIT_FIRST);
  });

  it('persists confirmed sessions next to the burner key and restores them for the same address', () => {
    const storage = memoryStorage();
    createHitGasPolicy({ address: A, chainId: 1, storage }).markConfirmed(7n);
    expect(storage.getItem(HIT_SESSIONS_STORAGE_KEY)).toBeTruthy();
    expect(createHitGasPolicy({ address: A, chainId: 1, storage }).gasFor(7n)).toBe(HIT_GAS_LIMIT);
    // A different burner never inherits another address's contributor slots.
    expect(createHitGasPolicy({ address: B, chainId: 1, storage }).gasFor(7n)).toBe(HIT_GAS_LIMIT_FIRST);
  });

  it('survives malformed storage and reports (never swallows) storage failures', () => {
    const warn = vi.fn();
    const bad = memoryStorage({ [HIT_SESSIONS_STORAGE_KEY]: '{not json' });
    expect(createHitGasPolicy({ address: A, chainId: 1, storage: bad, warn }).gasFor(1n)).toBe(HIT_GAS_LIMIT_FIRST);
    expect(warn).toHaveBeenCalledTimes(1);
    const throwing = { ...memoryStorage(), getItem: () => { throw new Error('quota'); }, setItem: () => { throw new Error('quota'); } };
    const policy = createHitGasPolicy({ address: A, chainId: 1, storage: throwing, warn });
    policy.markConfirmed(1n);
    expect(policy.gasFor(1n)).toBe(HIT_GAS_LIMIT); // remembered in memory for this page load
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('keys the flags by chain id so a session played on anvil never lowers the limit for the same id on testnet (review M3)', () => {
    const storage = memoryStorage();
    createHitGasPolicy({ address: A, chainId: 31337, storage }).markConfirmed(1n);
    expect(createHitGasPolicy({ address: A, chainId: 31337, storage }).gasFor(1n)).toBe(HIT_GAS_LIMIT);
    expect(createHitGasPolicy({ address: A, chainId: 10143, storage }).gasFor(1n)).toBe(HIT_GAS_LIMIT_FIRST);
    // Flags written before the chain id existed are treated as stale.
    const legacy = memoryStorage({ [HIT_SESSIONS_STORAGE_KEY]: JSON.stringify({ address: A.toLowerCase(), sessions: ['1'] }) });
    expect(createHitGasPolicy({ address: A, chainId: 10143, storage: legacy, warn: () => undefined }).gasFor(1n)).toBe(HIT_GAS_LIMIT_FIRST);
  });

  it('works with no storage at all (memory only)', () => {
    const policy = createHitGasPolicy({ address: A, chainId: 1, storage: null });
    policy.markConfirmed(3n);
    expect(policy.gasFor(3n)).toBe(HIT_GAS_LIMIT);
  });
});
