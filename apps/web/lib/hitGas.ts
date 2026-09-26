/**
 * Hit gas tiers. Monad charges the gas LIMIT, not the gas used, so a player's hits must
 * carry the smallest safe limit: HIT_GAS_LIMIT_FIRST for the first hit in a session (it
 * appends a contributor slot) and HIT_GAS_LIMIT afterwards. Which sessions this burner has
 * already hit is remembered next to the burner key in localStorage, keyed by address so a
 * fresh burner starts over; storage failures are reported and the flag lives in memory.
 */
import type { Address } from 'viem';
import { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST } from '@blockbeat/shared';
import type { StorageLike } from './burner';

export const HIT_SESSIONS_STORAGE_KEY = 'blockbeat:burner:hits:v2';

export interface HitGasPolicy {
  gasFor(sessionId: bigint): bigint;
  /** A Hit by this burner was confirmed in the session: later hits use the lower limit. */
  markConfirmed(sessionId: bigint): void;
}

export interface HitGasPolicyOptions {
  address: Address;
  /** Chain the flags belong to; flags stored for another chain are ignored. */
  chainId: number;
  /** Defaults to window.localStorage; null keeps the flags in memory only. */
  storage?: StorageLike | null;
  warn?: (message: string) => void;
}

interface Stored {
  address: string;
  chainId: number;
  sessions: string[];
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    // Accessing window.localStorage itself throws in some sandboxed contexts.
    return null;
  }
}

function isStored(value: unknown): value is Stored {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { address?: unknown; chainId?: unknown; sessions?: unknown };
  return (
    typeof v.address === 'string' &&
    typeof v.chainId === 'number' &&
    Array.isArray(v.sessions) &&
    v.sessions.every((s) => typeof s === 'string')
  );
}

export function createHitGasPolicy(options: HitGasPolicyOptions): HitGasPolicy {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const address = options.address.toLowerCase();
  const { chainId } = options;
  const confirmed = new Set<string>();

  if (storage) {
    try {
      const raw = storage.getItem(HIT_SESSIONS_STORAGE_KEY);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (!isStored(parsed)) throw new Error('unexpected shape');
        if (parsed.address === address && parsed.chainId === chainId) for (const s of parsed.sessions) confirmed.add(s);
      }
    } catch (error) {
      warn(`hitGas: stored session flags unreadable (${describe(error)}); starting from the first-hit limit`);
    }
  }

  function persist(): void {
    if (!storage) return;
    const value: Stored = { address, chainId, sessions: [...confirmed] };
    try {
      storage.setItem(HIT_SESSIONS_STORAGE_KEY, JSON.stringify(value));
    } catch (error) {
      warn(`hitGas: could not persist session flags (${describe(error)}); kept in memory`);
    }
  }

  return {
    gasFor(sessionId) {
      return confirmed.has(sessionId.toString()) ? HIT_GAS_LIMIT : HIT_GAS_LIMIT_FIRST;
    },
    markConfirmed(sessionId) {
      const key = sessionId.toString();
      if (confirmed.has(key)) return;
      confirmed.add(key);
      persist();
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
