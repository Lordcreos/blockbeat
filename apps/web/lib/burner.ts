/**
 * Burner wallet: a viem private key generated in the browser and kept in localStorage
 * under a namespaced key. Every storage access is guarded (Safari private mode and
 * embedded webviews throw). The key never leaves this module except inside the viem
 * account object; the returned wallet exposes only the address.
 */
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { createLocalNonceManager } from './localNonce';
import type { BurnerWallet } from './types';

export const BURNER_STORAGE_KEY = 'blockbeat:burner:pk:v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BurnerAccount extends BurnerWallet {
  /**
   * viem account with a local-first nonce manager (W16, lib/localNonce.ts): the pending count is
   * read once, then every hit and tip takes the next nonce locally, so rapid taps never collide
   * and each is a single eth_sendRawTransaction. Reset on a send error or a receipt timeout.
   */
  account: PrivateKeyAccount;
  /** False when storage was unavailable and the key lives only in memory. */
  persisted: boolean;
}

export interface LoadBurnerOptions {
  /** Defaults to window.localStorage when present. */
  storage?: StorageLike | null;
  /** Non-fatal problems are reported here (never with key material). Defaults to console.warn. */
  warn?: (message: string) => void;
}

const PK_RE = /^0x[0-9a-fA-F]{64}$/;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    // Accessing window.localStorage itself throws in some sandboxed contexts.
    return null;
  }
}

function toAccount(privateKey: Hex): PrivateKeyAccount {
  return privateKeyToAccount(privateKey, { nonceManager: createLocalNonceManager() });
}

export function loadOrCreateBurner(options: LoadBurnerOptions = {}): BurnerAccount {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const warn = options.warn ?? ((m: string) => console.warn(m));

  let stored: string | null = null;
  if (storage) {
    try {
      stored = storage.getItem(BURNER_STORAGE_KEY);
    } catch (error) {
      warn(`burner: localStorage read failed (${describe(error)}); using a memory-only key`);
    }
  }

  if (stored !== null && PK_RE.test(stored)) {
    const account = toAccount(stored as Hex);
    return { address: account.address, restored: true, account, persisted: true };
  }
  if (stored !== null) {
    warn('burner: stored key was malformed; generating a new one');
  }

  const privateKey = generatePrivateKey();
  const account = toAccount(privateKey);
  let persisted = false;
  if (storage) {
    try {
      storage.setItem(BURNER_STORAGE_KEY, privateKey);
      persisted = true;
    } catch (error) {
      warn(`burner: localStorage write failed (${describe(error)}); key will not survive a reload`);
    }
  }
  return { address: account.address, restored: false, account, persisted };
}

/** Removes the stored key, e.g. to start over with a fresh burner. */
export function clearBurner(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(BURNER_STORAGE_KEY);
  } catch (error) {
    throw new Error(`burner: could not clear stored key (${describe(error)})`, { cause: error });
  }
}

export function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.name || error.message : String(error);
}
