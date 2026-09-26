/**
 * W21b: the mock bus. In mock mode every tab runs its own simulator, so a note tapped on the
 * phone tab never reached the stage tab. Simulators on one origin now share their
 * transactions over a BroadcastChannel: each tab mines the others' hits and tips into its own
 * chain (same tx hash, its own block), and a tab that opens a session asks the others for what
 * that session already holds. Mock only; nothing here touches a chain. Messages are validated
 * on receipt (any same-origin page can post on the channel).
 */
import { isAddress, type Address, type Hash } from 'viem';

export const MOCK_BUS_CHANNEL = 'blockbeat:mock:v1';
/** Most hits and tips one sync answer carries per session. */
export const MOCK_SYNC_LIMIT = 2_000;

export interface BusHit {
  sessionId: string;
  player: Address;
  track: number;
  note: number;
  txHash: Hash;
}

export interface BusTip {
  sessionId: string;
  from: Address;
  amountWei: string;
  txHash: Hash;
}

export type BusMessage =
  | ({ kind: 'hit' } & BusHit)
  | ({ kind: 'tip' } & BusTip)
  | { kind: 'sync-request'; sessionId: string }
  | { kind: 'finalize'; sessionId: string; tokenId: string }
  | { kind: 'sync'; sessionId: string; hits: BusHit[]; tips: BusTip[] };

export interface MockBus {
  post(message: BusMessage): void;
  subscribe(cb: (message: BusMessage) => void): () => void;
  close(): void;
}

const HASH_RE = /^0x[0-9a-f]{64}$/i;
const UINT_RE = /^\d{1,78}$/;

function isHit(v: unknown): v is BusHit {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.sessionId === 'string' && UINT_RE.test(h.sessionId) &&
    typeof h.player === 'string' && isAddress(h.player) &&
    Number.isInteger(h.track) && Number.isInteger(h.note) &&
    typeof h.txHash === 'string' && HASH_RE.test(h.txHash)
  );
}

function isTip(v: unknown): v is BusTip {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.sessionId === 'string' && UINT_RE.test(t.sessionId) &&
    typeof t.from === 'string' && isAddress(t.from) &&
    typeof t.amountWei === 'string' && UINT_RE.test(t.amountWei) &&
    typeof t.txHash === 'string' && HASH_RE.test(t.txHash)
  );
}

export function parseBusMessage(v: unknown): BusMessage | null {
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  switch (m.kind) {
    case 'hit':
      return isHit(m) ? { kind: 'hit', sessionId: m.sessionId, player: m.player, track: m.track, note: m.note, txHash: m.txHash } : null;
    case 'tip':
      return isTip(m) ? { kind: 'tip', sessionId: m.sessionId, from: m.from, amountWei: m.amountWei, txHash: m.txHash } : null;
    case 'sync-request':
      return typeof m.sessionId === 'string' && UINT_RE.test(m.sessionId) ? { kind: 'sync-request', sessionId: m.sessionId } : null;
    case 'finalize':
      return typeof m.sessionId === 'string' && UINT_RE.test(m.sessionId) && typeof m.tokenId === 'string' && UINT_RE.test(m.tokenId)
        ? { kind: 'finalize', sessionId: m.sessionId, tokenId: m.tokenId }
        : null;
    case 'sync': {
      if (typeof m.sessionId !== 'string' || !UINT_RE.test(m.sessionId) || !Array.isArray(m.hits) || !Array.isArray(m.tips)) return null;
      if (m.hits.length > MOCK_SYNC_LIMIT || m.tips.length > MOCK_SYNC_LIMIT) return null;
      if (!m.hits.every(isHit) || !m.tips.every(isTip)) return null;
      return { kind: 'sync', sessionId: m.sessionId, hits: m.hits, tips: m.tips };
    }
    default:
      return null;
  }
}

/** The browser bus; null where BroadcastChannel does not exist (old browsers, SSR). */
export function createBroadcastBus(name: string = MOCK_BUS_CHANNEL): MockBus | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(name);
  const listeners = new Set<(message: BusMessage) => void>();
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = parseBusMessage(event.data);
    if (!message) return;
    for (const cb of listeners) cb(message);
  };
  return {
    post: (message) => channel.postMessage(message),
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close: () => channel.close(),
  };
}

/** Tests: endpoints of one hub hear each other's posts (never their own), asynchronously, like BroadcastChannel. */
export function createMemoryHub(): { endpoint(): MockBus } {
  const endpoints = new Set<{ deliver(message: BusMessage): void }>();
  return {
    endpoint() {
      const listeners = new Set<(message: BusMessage) => void>();
      const self = {
        deliver(message: BusMessage) {
          for (const cb of listeners) cb(message);
        },
      };
      endpoints.add(self);
      return {
        post(message) {
          const copy = parseBusMessage(JSON.parse(JSON.stringify(message)) as unknown);
          if (!copy) throw new Error(`mock bus: refused to post a malformed ${message.kind} message`);
          for (const other of endpoints) if (other !== self) queueMicrotask(() => other.deliver(copy));
        },
        subscribe(cb) {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        close: () => endpoints.delete(self),
      };
    },
  };
}
