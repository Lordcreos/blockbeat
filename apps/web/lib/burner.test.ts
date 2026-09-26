import { describe, expect, it, vi } from 'vitest';
import { isAddress } from 'viem';
import { BURNER_STORAGE_KEY, TIPPER_BURNER_STORAGE_KEY, loadOrCreateBurner, type StorageLike } from './burner';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

const PK = `0x${'11'.repeat(32)}` as const;

describe('loadOrCreateBurner', () => {
  it('generates a key, persists it under the namespaced key and reports restored=false', () => {
    const storage = memoryStorage();
    const b = loadOrCreateBurner({ storage });
    expect(isAddress(b.address)).toBe(true);
    expect(b.restored).toBe(false);
    expect(b.persisted).toBe(true);
    expect(storage.data.get(BURNER_STORAGE_KEY)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BURNER_STORAGE_KEY).toMatch(/^blockbeat:/);
    expect(b.account.address).toBe(b.address);
    expect(b.account.nonceManager).toBeDefined();
  });

  it('W21b: the tip page keeps its own key under a separate storage key, never the player burner', () => {
    const storage = memoryStorage({ [BURNER_STORAGE_KEY]: PK });
    const tipper = loadOrCreateBurner({ storage, storageKey: TIPPER_BURNER_STORAGE_KEY });
    expect(tipper.restored).toBe(false);
    expect(TIPPER_BURNER_STORAGE_KEY).not.toBe(BURNER_STORAGE_KEY);
    expect(storage.data.get(TIPPER_BURNER_STORAGE_KEY)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(storage.data.get(BURNER_STORAGE_KEY)).toBe(PK);
    expect(loadOrCreateBurner({ storage, storageKey: TIPPER_BURNER_STORAGE_KEY }).address).toBe(tipper.address);
  });

  it('restores an existing key', () => {
    const storage = memoryStorage({ [BURNER_STORAGE_KEY]: PK });
    const b = loadOrCreateBurner({ storage });
    expect(b.restored).toBe(true);
    expect(b.address).toBe('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
  });

  it('replaces a corrupt stored key and warns', () => {
    const warn = vi.fn();
    const storage = memoryStorage({ [BURNER_STORAGE_KEY]: 'garbage' });
    const b = loadOrCreateBurner({ storage, warn });
    expect(b.restored).toBe(false);
    expect(storage.data.get(BURNER_STORAGE_KEY)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('garbage');
  });

  it('falls back to a memory-only key when storage throws, and warns without leaking the key', () => {
    const warn = vi.fn();
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => undefined,
    };
    const b = loadOrCreateBurner({ storage, warn });
    expect(isAddress(b.address)).toBe(true);
    expect(b.persisted).toBe(false);
    expect(b.restored).toBe(false);
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/0x[0-9a-f]{64}/);
    }
  });

  it('works with no storage at all (server render)', () => {
    const b = loadOrCreateBurner({ storage: null });
    expect(isAddress(b.address)).toBe(true);
    expect(b.persisted).toBe(false);
  });

  it('never exposes the private key on the wallet object', () => {
    const b = loadOrCreateBurner({ storage: memoryStorage({ [BURNER_STORAGE_KEY]: PK }) });
    expect(JSON.stringify(b)).not.toContain(PK.slice(2));
    expect(Object.values(b.account).some((v) => typeof v === 'string' && v.includes(PK.slice(2)))).toBe(false);
  });
});
