/**
 * W16: a local-first nonce manager for the burner. viem's default manager reads
 * eth_getTransactionCount before EVERY send, and shares one in-flight read between sends that
 * overlap, so a tap took one or two round trips depending on what else was in flight. On anvil
 * with +300 ms per round trip that bimodal send path was the main source of aimed notes landing
 * a block early (docs/evidence/w16-playable-phone). This manager reads the pending count once,
 * then hands out the next nonce locally: every hit and tip is exactly one eth_sendRawTransaction.
 *
 * reset() (a send error such as "nonce too low/high", a receipt timeout, a dropped tx) forgets
 * the local count, re-reads it at once in the background so the next send stays on the short
 * path, and tells listeners (the aim queue re-times its waiting notes).
 */
import { getTransactionCount } from 'viem/actions';
import type { Address, Client } from 'viem';
import type { NonceManager } from 'viem/accounts';

interface Key {
  address: Address;
  chainId: number;
}

export interface LocalNonceManager extends NonceManager {
  /** Called after every reset, with the account and chain that was reset. */
  onReset(cb: (key: Key) => void): () => void;
}

export interface LocalNonceManagerOptions {
  warn?: (message: string) => void;
}

interface Slot {
  /** The next nonce to hand out; null until read (or after a reset). */
  next: number | null;
  reading: Promise<number> | null;
  /** The last client that consumed, used for the warm re-read after a reset. */
  client: Client | null;
}

const LOCAL = Symbol('blockbeat.localNonce');

export function isLocalNonceManager(manager: NonceManager | undefined): manager is LocalNonceManager {
  return typeof manager === 'object' && manager !== null && LOCAL in manager;
}

export function createLocalNonceManager(options: LocalNonceManagerOptions = {}): LocalNonceManager {
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const slots = new Map<string, Slot>();
  const listeners = new Set<(key: Key) => void>();
  const keyOf = ({ address, chainId }: Key): string => `${address.toLowerCase()}.${chainId}`;
  const slotOf = (key: Key): Slot => {
    const k = keyOf(key);
    let slot = slots.get(k);
    if (!slot) {
      slot = { next: null, reading: null, client: null };
      slots.set(k, slot);
    }
    return slot;
  };

  /** One read of the pending count per slot at a time; a failed read is not cached. */
  function read(slot: Slot, key: Key, client: Client): Promise<number> {
    if (!slot.reading) {
      const reading = getTransactionCount(client, { address: key.address, blockTag: 'pending' }).then(
        (count) => {
          if (slot.reading !== reading) return count; // a reset replaced this read
          slot.reading = null;
          if (slot.next === null) slot.next = count;
          return count;
        },
        (error: unknown) => {
          if (slot.reading === reading) slot.reading = null;
          throw error;
        },
      );
      slot.reading = reading;
    }
    return slot.reading;
  }

  const manager: LocalNonceManager & { [LOCAL]: true } = {
    [LOCAL]: true,
    async consume({ address, chainId, client }) {
      const key = { address, chainId };
      const slot = slotOf(key);
      slot.client = client;
      while (slot.next === null) await read(slot, key, client);
      const nonce = slot.next;
      slot.next = nonce + 1;
      return nonce;
    },
    increment({ address, chainId }) {
      const slot = slotOf({ address, chainId });
      if (slot.next !== null) slot.next += 1;
    },
    async get({ address, chainId, client }) {
      const key = { address, chainId };
      const slot = slotOf(key);
      while (slot.next === null) await read(slot, key, client);
      return slot.next;
    },
    reset({ address, chainId }) {
      const key = { address, chainId };
      const slot = slotOf(key);
      slot.next = null;
      slot.reading = null;
      if (slot.client) {
        read(slot, key, slot.client).catch((error: unknown) => {
          warn(`nonce: re-read after reset failed (${error instanceof Error ? error.message : String(error)}); the next send reads it`);
        });
      }
      for (const cb of [...listeners]) cb(key);
    },
    onReset(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return manager;
}
