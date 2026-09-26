import { describe, expect, it, vi } from 'vitest';
import { createWalletClient, custom, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from '@blockbeat/shared';
import { createChainHitWriter } from './chain/hitWriter';
import { createChainTipWriter } from './chain/tipWriter';
import { loadOrCreateBurner, type StorageLike } from './burner';
import { createLocalNonceManager, isLocalNonceManager } from './localNonce';

const ADDR = '0x00000000000000000000000000000000000000aa';
const PK = `0x${'11'.repeat(32)}` as Hex;

/** A real viem wallet on a recording transport: every RPC method, and the nonce of every raw tx. */
function recording(options: { pending?: number; failSend?: () => boolean } = {}) {
  const methods: string[] = [];
  const nonces: number[] = [];
  let pending = options.pending ?? 5;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      methods.push(method);
      switch (method) {
        case 'eth_getTransactionCount':
          return `0x${pending.toString(16)}`;
        case 'eth_sendRawTransaction': {
          if (options.failSend?.()) throw new Error('nonce too low');
          const raw = (params as [Hex])[0];
          const tx = parseTransaction(raw);
          nonces.push(tx.nonce ?? -1);
          pending = Math.max(pending, (tx.nonce ?? 0) + 1);
          return `0x${'ab'.repeat(32)}`;
        }
        default:
          throw new Error(`${method} is not available`);
      }
    },
  });
  return { methods, nonces, transport, setPending: (n: number) => (pending = n) };
}

const reads = (methods: string[]) => methods.filter((m) => m === 'eth_getTransactionCount').length;
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const memoryStorage = (): StorageLike => {
  const store = new Map<string, string>();
  return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) };
};

describe('createLocalNonceManager (W16)', () => {
  it('reads the pending count once, then every hit is a single raw send with the next nonce', async () => {
    const r = recording({ pending: 5 });
    const account = privateKeyToAccount(PK, { nonceManager: createLocalNonceManager() });
    const wallet = createWalletClient({ account, chain: monadTestnet, transport: r.transport });
    const write = createChainHitWriter({ wallet, address: ADDR });
    for (let i = 0; i < 3; i++) await write({ sessionId: 1n, track: 0, note: i });
    expect(r.methods).toEqual(['eth_getTransactionCount', 'eth_sendRawTransaction', 'eth_sendRawTransaction', 'eth_sendRawTransaction']);
    expect(r.nonces).toEqual([5, 6, 7]);
  });

  it('concurrent sends share the one read and still get distinct nonces', async () => {
    const r = recording({ pending: 2 });
    const account = privateKeyToAccount(PK, { nonceManager: createLocalNonceManager() });
    const wallet = createWalletClient({ account, chain: monadTestnet, transport: r.transport });
    const write = createChainHitWriter({ wallet, address: ADDR });
    await Promise.all([0, 1, 2, 3].map((n) => write({ sessionId: 1n, track: 0, note: n })));
    expect(reads(r.methods)).toBe(1);
    expect([...r.nonces].sort()).toEqual([2, 3, 4, 5]);
  });

  it('hits and tips from the burner share one nonce sequence', async () => {
    const r = recording({ pending: 0 });
    const burner = loadOrCreateBurner({ storage: memoryStorage() });
    expect(isLocalNonceManager(burner.account.nonceManager)).toBe(true);
    const wallet = createWalletClient({ account: burner.account, chain: monadTestnet, transport: r.transport });
    await createChainHitWriter({ wallet, address: ADDR })({ sessionId: 1n, track: 0, note: 0 });
    await createChainTipWriter({ wallet, address: ADDR })({ sessionId: 1n, valueWei: 1n });
    await createChainHitWriter({ wallet, address: ADDR })({ sessionId: 1n, track: 0, note: 1 });
    expect(reads(r.methods)).toBe(1);
    expect(r.nonces).toEqual([0, 1, 2]);
  });

  it('a page reload restores the sequence by re-reading the pending count once', async () => {
    const r = recording({ pending: 0 });
    const storage = memoryStorage();
    const first = loadOrCreateBurner({ storage });
    const w1 = createWalletClient({ account: first.account, chain: monadTestnet, transport: r.transport });
    await createChainHitWriter({ wallet: w1, address: ADDR })({ sessionId: 1n, track: 0, note: 0 });
    await createChainHitWriter({ wallet: w1, address: ADDR })({ sessionId: 1n, track: 0, note: 1 });
    const reloaded = loadOrCreateBurner({ storage });
    expect(reloaded.address).toBe(first.address);
    const w2 = createWalletClient({ account: reloaded.account, chain: monadTestnet, transport: r.transport });
    await createChainHitWriter({ wallet: w2, address: ADDR })({ sessionId: 1n, track: 0, note: 2 });
    expect(reads(r.methods)).toBe(2);
    expect(r.nonces).toEqual([0, 1, 2]);
  });

  it('a send error (nonce too low) resets: listeners hear it, the count is re-read at once, the next send uses it', async () => {
    let fail = false;
    const r = recording({ pending: 3, failSend: () => fail });
    const manager = createLocalNonceManager();
    const onReset = vi.fn();
    manager.onReset(onReset);
    const account = privateKeyToAccount(PK, { nonceManager: manager });
    const wallet = createWalletClient({ account, chain: monadTestnet, transport: r.transport });
    const write = createChainHitWriter({ wallet, address: ADDR });
    await write({ sessionId: 1n, track: 0, note: 0 }); // nonce 3
    fail = true;
    r.setPending(9); // someone else moved the account on
    await expect(write({ sessionId: 1n, track: 0, note: 1 })).rejects.toThrow(/nonce too low/);
    expect(onReset).toHaveBeenCalledTimes(1);
    await settle();
    expect(reads(r.methods)).toBe(2); // the warm re-read, before any next send
    fail = false;
    const before = r.methods.length;
    await write({ sessionId: 1n, track: 0, note: 2 });
    expect(r.nonces.at(-1)).toBe(9);
    expect(r.methods.slice(before)).toEqual(['eth_sendRawTransaction']);
  });

  it('a receipt timeout resets the nonce (the tx may have been dropped)', async () => {
    const r = recording({ pending: 0 });
    const manager = createLocalNonceManager();
    const onReset = vi.fn();
    manager.onReset(onReset);
    const account = privateKeyToAccount(PK, { nonceManager: manager });
    const wallet = createWalletClient({ account, chain: monadTestnet, transport: r.transport });
    const warn = vi.fn();
    const receipts = { waitForTransactionReceipt: vi.fn(async () => Promise.reject(new Error('timed out'))) };
    await createChainHitWriter({ wallet, address: ADDR, receipts, warn })({ sessionId: 1n, track: 0, note: 0 });
    await settle();
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('a tip send error resets the shared nonce too', async () => {
    const r = recording({ pending: 0, failSend: () => true });
    const manager = createLocalNonceManager();
    const onReset = vi.fn();
    manager.onReset(onReset);
    const wallet = createWalletClient({ account: privateKeyToAccount(PK, { nonceManager: manager }), chain: monadTestnet, transport: r.transport });
    await expect(createChainTipWriter({ wallet, address: ADDR })({ sessionId: 1n, valueWei: 1n })).rejects.toThrow();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('a failed read is not cached: the next consume reads again', async () => {
    let failRead = true;
    const manager = createLocalNonceManager({ warn: vi.fn() });
    const transport = custom({
      async request({ method }: { method: string }) {
        if (method !== 'eth_getTransactionCount') throw new Error(`${method} is not available`);
        if (failRead) throw new Error('rate limited');
        return '0x4';
      },
    });
    const client = createWalletClient({ account: privateKeyToAccount(PK), chain: monadTestnet, transport });
    const who = { address: client.account.address, chainId: monadTestnet.id };
    await expect(manager.consume({ ...who, client })).rejects.toThrow(/rate limited/);
    failRead = false;
    await expect(manager.consume({ ...who, client })).resolves.toBe(4);
    await expect(manager.consume({ ...who, client })).resolves.toBe(5);
  });
});
