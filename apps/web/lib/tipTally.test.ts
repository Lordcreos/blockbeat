import { describe, expect, it, vi } from 'vitest';
import { createTipTally, TIP_TALLY_STORAGE_PREFIX } from './tipTally';
import type { StorageLike } from './burner';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const ADDRESS = '0xAbCdEf0000000000000000000000000000000001' as const;

describe('tip tally (W12)', () => {
  it('counts tips per burner and session and survives a reload', () => {
    const storage = memory();
    const tally = createTipTally({ address: ADDRESS, sessionId: 3n, storage });
    expect(tally.count()).toBe(0);
    expect(tally.add()).toBe(1);
    expect(tally.add()).toBe(2);
    expect(storage.data.get(`${TIP_TALLY_STORAGE_PREFIX}${ADDRESS.toLowerCase()}:3`)).toBe('2');
    expect(createTipTally({ address: ADDRESS, sessionId: 3n, storage }).count()).toBe(2);
    expect(createTipTally({ address: ADDRESS, sessionId: 4n, storage }).count()).toBe(0);
  });

  it('keeps counting in memory when storage fails, and says so', () => {
    const warn = vi.fn();
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    const tally = createTipTally({ address: ADDRESS, sessionId: 3n, storage: broken, warn });
    expect(tally.count()).toBe(0);
    expect(tally.add()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('ignores a corrupt stored value', () => {
    const storage = memory();
    storage.data.set(`${TIP_TALLY_STORAGE_PREFIX}${ADDRESS.toLowerCase()}:3`, 'lots');
    const warn = vi.fn();
    expect(createTipTally({ address: ADDRESS, sessionId: 3n, storage, warn }).count()).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
