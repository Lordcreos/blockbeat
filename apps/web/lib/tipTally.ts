/**
 * W12: how many tips this burner sent in a session, for the phone's "You tipped N times"
 * line. Kept next to the burner key in localStorage so a reload keeps the count; storage
 * failures are reported and the count lives in memory.
 */
import type { Address } from 'viem';
import type { StorageLike } from './burner';

export const TIP_TALLY_STORAGE_PREFIX = 'blockbeat:tips:v1:';

export interface TipTally {
  count(): number;
  /** Records one landed tip and returns the new count. */
  add(): number;
}

export interface TipTallyOptions {
  address: Address;
  sessionId: bigint;
  /** Defaults to window.localStorage; null keeps the count in memory only. */
  storage?: StorageLike | null;
  warn?: (message: string) => void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    // Accessing window.localStorage itself throws in some sandboxed contexts.
    return null;
  }
}

const listeners = new Set<() => void>();

/** Notified after any tally changes (for useSyncExternalStore). */
export function subscribeTipTallies(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function createTipTally(options: TipTallyOptions): TipTally {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const key = `${TIP_TALLY_STORAGE_PREFIX}${options.address.toLowerCase()}:${options.sessionId.toString()}`;
  let count = 0;

  if (storage) {
    try {
      const raw = storage.getItem(key);
      if (raw !== null) {
        if (!/^\d{1,6}$/.test(raw)) throw new Error(`unexpected value "${raw.slice(0, 12)}"`);
        count = Number(raw);
      }
    } catch (error) {
      warn(`tipTally: stored count unreadable (${error instanceof Error ? error.message : String(error)}); starting at 0`);
    }
  }

  return {
    count: () => count,
    add() {
      count += 1;
      if (storage) {
        try {
          storage.setItem(key, String(count));
        } catch (error) {
          warn(`tipTally: could not persist the count (${error instanceof Error ? error.message : String(error)}); kept in memory`);
        }
      }
      for (const cb of listeners) cb();
      return count;
    },
  };
}
