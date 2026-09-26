import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Hash, type Log, type TransactionSerializableEIP1559 } from 'viem';
import { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, HIT_MAX_FEE_PER_GAS, HIT_MAX_PRIORITY_FEE_PER_GAS, blockbeatAbi } from '@blockbeat/shared';
import { createChainHitSender, createChainIdentity, createClients, createHitLogStream, createNonceSource, type HitLogStream, type SeenHit } from './chain';

function fakeStream(): HitLogStream & { emit(hit: SeenHit): void } {
  const listeners = new Set<(hit: SeenHit) => void>();
  return {
    onHit(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    stop: () => listeners.clear(),
    emit(hit) {
      for (const cb of listeners) cb(hit);
    },
  };
}
import { REGISTER_GAS_LIMIT, erc8004IdentityAbi } from './identity';

const ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const PLAYER = '0x2222222222222222222222222222222222222222' as const;
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const HASH = `0x${'ab'.repeat(32)}` as Hash;

function hitLog(sessionId: bigint, step: number, track: number, note: number, on: boolean): Log {
  const topics = encodeEventTopics({ abi: blockbeatAbi, eventName: 'Hit', args: { sessionId, player: PLAYER } });
  const data = encodeAbiParameters(
    [{ type: 'uint64' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'bool' }],
    [123n, step, track, note, on],
  );
  return { address: ADDRESS, topics, data, blockNumber: 123n, transactionHash: HASH, logIndex: 0, blockHash: HASH, transactionIndex: 0, removed: false } as Log;
}

describe('chain hit sender', () => {
  it('writes hit() with the fixed gas limits and never estimates gas: the first-hit tier until a hit has landed, the lower tier after', async () => {
    const writeContract = vi.fn(async () => HASH);
    const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success', blockNumber: 123n, gasUsed: 61_011n, logs: [hitLog(7n, 13, 2, 0, true)] }));
    const sender = createChainHitSender({
      wallet: { writeContract } as never,
      publicClient: { waitForTransactionReceipt } as never,
      address: ADDRESS,
      sessionId: 7n,
      hasHitBefore: false,
    });
    await expect(sender.send(2, 5)).resolves.toBe(HASH);
    expect(writeContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        functionName: 'hit',
        args: [7n, 2, 5],
        gas: HIT_GAS_LIMIT_FIRST,
        maxFeePerGas: HIT_MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS,
      }),
    );
    // Still in flight: the contributor push may still be pending, keep the higher limit.
    await sender.send(3, 0);
    expect(writeContract).toHaveBeenLastCalledWith(expect.objectContaining({ gas: HIT_GAS_LIMIT_FIRST }));
    await sender.confirm(HASH);
    await sender.send(4, 1);
    expect(writeContract).toHaveBeenLastCalledWith(expect.objectContaining({ gas: HIT_GAS_LIMIT }));
    await expect(sender.send(9 as never, 0)).rejects.toThrow(/invalid hit/);
  });

  it('uses the lower tier from the start when the agent already has hits in the session', async () => {
    const writeContract = vi.fn(async () => HASH);
    const sender = createChainHitSender({ wallet: { writeContract } as never, publicClient: {} as never, address: ADDRESS, sessionId: 7n, hasHitBefore: true });
    await sender.send(0, 0);
    expect(writeContract).toHaveBeenLastCalledWith(expect.objectContaining({ gas: HIT_GAS_LIMIT }));
  });

  it('decodes the landing block, step, on flag and gas from the receipt', async () => {
    const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success', blockNumber: 123n, gasUsed: 61_011n, logs: [hitLog(7n, 13, 2, 0, true)] }));
    const sender = createChainHitSender({ wallet: {} as never, publicClient: { waitForTransactionReceipt } as never, address: ADDRESS, sessionId: 7n, hasHitBefore: false });
    await expect(sender.confirm(HASH)).resolves.toEqual({ blockNumber: 123n, step: 13, on: true, gasUsed: 61_011n });
  });

  it('W17: reports the MON charged on the receipt path (gas limit x effective gas price) only when both are known', async () => {
    const writeContract = vi.fn(async () => HASH);
    const receipt = { status: 'success', blockNumber: 123n, gasUsed: 61_011n, logs: [hitLog(7n, 13, 2, 0, true)] };
    const priced = createChainHitSender({
      wallet: { writeContract } as never,
      publicClient: { waitForTransactionReceipt: async () => ({ ...receipt, effectiveGasPrice: 102_000_000_000n }) } as never,
      address: ADDRESS,
      sessionId: 7n,
      hasHitBefore: false,
    });
    await priced.send(2, 0);
    await expect(priced.confirm(HASH)).resolves.toMatchObject({ feeWei: HIT_GAS_LIMIT_FIRST * 102_000_000_000n });
    // No price on the receipt, or a hash this sender never sent: no fee is invented.
    const unpriced = createChainHitSender({ wallet: { writeContract } as never, publicClient: { waitForTransactionReceipt: async () => receipt } as never, address: ADDRESS, sessionId: 7n, hasHitBefore: false });
    await unpriced.send(2, 0);
    expect(await unpriced.confirm(HASH)).not.toHaveProperty('feeWei');
    expect(await priced.confirm(HASH)).not.toHaveProperty('feeWei');
  });

  it('rejects reverted receipts, missing logs and logs of another session', async () => {
    const mk = (receipt: Record<string, unknown>) =>
      createChainHitSender({ wallet: {} as never, publicClient: { waitForTransactionReceipt: async () => receipt } as never, address: ADDRESS, sessionId: 7n, hasHitBefore: true });
    await expect(mk({ status: 'reverted', blockNumber: 1n, gasUsed: 0n, logs: [] }).confirm(HASH)).rejects.toThrow(/reverted/);
    await expect(mk({ status: 'success', blockNumber: 1n, gasUsed: 0n, logs: [] }).confirm(HASH)).rejects.toThrow(/no Hit log/);
    await expect(mk({ status: 'success', blockNumber: 1n, gasUsed: 0n, logs: [hitLog(8n, 0, 0, 0, true)] }).confirm(HASH)).rejects.toThrow(/session 8/);
  });
});

describe('batched sender (W17: a phrase puts 3-4 notes on one step)', () => {
  function batchRig(options: { failAt?: number; pending?: number } = {}) {
    const order: Array<{ nonce: number; track: number; note: number }> = [];
    const broadcasts: Array<{ tick: number; raw: string }> = [];
    let tick = 0;
    const bump = setInterval(() => (tick += 1), 0);
    const signTransaction = vi.fn(async (tx: TransactionSerializableEIP1559) => {
      const args = decodeFunctionData({ abi: blockbeatAbi, data: (tx.data ?? '0x') as `0x${string}` }).args as readonly [bigint, number, number];
      order.push({ nonce: tx.nonce ?? -1, track: args[1], note: args[2] });
      return `0xsigned${tx.nonce}` as `0x${string}`;
    });
    const getTransactionCount = vi.fn(async () => options.pending ?? 40);
    const nonces = createNonceSource(getTransactionCount);
    let n = 0;
    const sendRawTransaction = vi.fn(async ({ serializedTransaction }: { serializedTransaction: string }) => {
      broadcasts.push({ tick, raw: serializedTransaction });
      n += 1;
      if (options.failAt === n) throw new Error('nonce too high');
      return `0x${serializedTransaction.slice(8).padStart(64, '0')}` as Hash;
    });
    const sender = createChainHitSender({
      wallet: { writeContract: vi.fn() } as never,
      publicClient: {} as never,
      address: ADDRESS,
      sessionId: 7n,
      hasHitBefore: true,
      batch: { signer: { address: PLAYER, signTransaction }, rpc: { sendRawTransaction }, chainId: 10143, nonces },
    });
    return { sender, order, broadcasts, signTransaction, getTransactionCount, sendRawTransaction, nonces, stop: () => clearInterval(bump) };
  }

  it('signs the hits of one step locally with consecutive nonces (fixed gas and fees) and broadcasts them together, in order', async () => {
    const rig = batchRig();
    const hashes = await Promise.all([rig.sender.send(0, 10), rig.sender.send(4, 0), rig.sender.send(6, 0)]);
    rig.stop();
    expect(hashes).toHaveLength(3);
    expect(rig.getTransactionCount).toHaveBeenCalledTimes(1);
    expect(rig.order).toEqual([
      { nonce: 40, track: 0, note: 10 },
      { nonce: 41, track: 4, note: 0 },
      { nonce: 42, track: 6, note: 0 },
    ]);
    expect(rig.signTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: ADDRESS, gas: HIT_GAS_LIMIT, maxFeePerGas: HIT_MAX_FEE_PER_GAS, maxPriorityFeePerGas: HIT_MAX_PRIORITY_FEE_PER_GAS, chainId: 10143, type: 'eip1559' }));
    expect(rig.broadcasts.map((b) => b.raw)).toEqual(['0xsigned40', '0xsigned41', '0xsigned42']);
    expect(new Set(rig.broadcasts.map((b) => b.tick)).size).toBe(1);
    // The next step continues from the local nonce, no second read.
    await rig.sender.send(2, 1);
    expect(rig.order.at(-1)?.nonce).toBe(43);
    expect(rig.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it('a rejected broadcast fails only that hit, and the next step re-reads the pending nonce (no stall on a gap)', async () => {
    const rig = batchRig({ failAt: 2 });
    const results = await Promise.allSettled([rig.sender.send(0, 10), rig.sender.send(4, 0)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    await rig.sender.send(2, 1);
    rig.stop();
    expect(rig.getTransactionCount).toHaveBeenCalledTimes(2);
    // The lagging node still says 40, but 40 was broadcast: fill the gap at 41, never reuse 40 (review).
    expect(rig.order.map((o) => o.nonce)).toEqual([40, 41, 41]);
  });

  it('shares one nonce authority with the ERC-8004 register tx (review: two managers on one account collide)', async () => {
    const rig = batchRig();
    const writeContract = vi.fn(async () => HASH);
    const identity = createChainIdentity({ wallet: { writeContract } as never, http: {} as never }, rig.nonces);
    await identity.register('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', 'data:x');
    await Promise.all([rig.sender.send(0, 10), rig.sender.send(4, 0)]);
    rig.stop();
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'register', nonce: 40 }));
    expect(rig.order.map((o) => o.nonce)).toEqual([41, 42]);
    expect(rig.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it('confirms with the MON charged: the gas LIMIT times the effective gas price (Monad charges the limit)', async () => {
    const rig = batchRig();
    const hash = await rig.sender.send(0, 10);
    rig.stop();
    const stream = fakeStream();
    const getTransactionReceipt = vi.fn(async () => ({ gasUsed: 61_011n, effectiveGasPrice: 102_000_000_000n, status: 'success', blockNumber: 123n }));
    const sender = createChainHitSender({
      wallet: {} as never,
      publicClient: { getTransactionReceipt } as never,
      address: ADDRESS,
      sessionId: 7n,
      hasHitBefore: true,
      hits: stream,
      batch: { signer: { address: PLAYER, signTransaction: rig.signTransaction }, rpc: { sendRawTransaction: rig.sendRawTransaction }, chainId: 10143, nonces: createNonceSource(rig.getTransactionCount) },
    });
    const sent = await sender.send(0, 10);
    const pending = sender.confirm(sent);
    stream.emit({ txHash: sent, sessionId: 7n, blockNumber: 123n, step: 13, on: true });
    await expect(pending).resolves.toEqual({ blockNumber: 123n, step: 13, on: true, gasUsed: 61_011n, feeWei: HIT_GAS_LIMIT * 102_000_000_000n });
    expect(hash).toBeDefined();
  });
});

describe('chain hit sender with a Hit log stream (review M4)', () => {
  it('confirms from the stream and fetches the receipt once for gasUsed instead of polling it', async () => {
    const stream = fakeStream();
    const getTransactionReceipt = vi.fn(async () => ({ status: 'success', blockNumber: 123n, gasUsed: 61_011n }));
    const waitForTransactionReceipt = vi.fn();
    const sender = createChainHitSender({
      wallet: {} as never,
      publicClient: { getTransactionReceipt, waitForTransactionReceipt } as never,
      address: ADDRESS,
      sessionId: 7n,
      hasHitBefore: false,
      hits: stream,
    });
    const p = sender.confirm(HASH);
    stream.emit({ txHash: `0x${'11'.repeat(32)}`, sessionId: 7n, blockNumber: 122n, step: 12, on: true });
    stream.emit({ txHash: HASH, sessionId: 7n, blockNumber: 123n, step: 13, on: true });
    await expect(p).resolves.toEqual({ blockNumber: 123n, step: 13, on: true, gasUsed: 61_011n });
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it('resolves a hit whose log arrived before confirm() was called', async () => {
    const stream = fakeStream();
    const publicClient = { getTransactionReceipt: async () => ({ status: 'success', blockNumber: 123n, gasUsed: 61_011n }) } as never;
    const sender = createChainHitSender({ wallet: {} as never, publicClient, address: ADDRESS, sessionId: 7n, hasHitBefore: false, hits: stream });
    stream.emit({ txHash: HASH, sessionId: 7n, blockNumber: 123n, step: 13, on: true });
    await expect(sender.confirm(HASH)).resolves.toMatchObject({ blockNumber: 123n, step: 13 });
  });

  it('falls back to one receipt lookup after the timeout and reports a revert', async () => {
    vi.useFakeTimers();
    try {
      const stream = fakeStream();
      const getTransactionReceipt = vi.fn(async () => ({ status: 'reverted', blockNumber: 124n, gasUsed: 80_000n }));
      const sender = createChainHitSender({ wallet: {} as never, publicClient: { getTransactionReceipt } as never, address: ADDRESS, sessionId: 7n, hasHitBefore: true, hits: stream, confirmTimeoutMs: 1_000 });
      const settled = sender.confirm(HASH).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await settled) as Error).toMatchObject({ message: expect.stringMatching(/reverted/) });
      expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the receipt lookup failure when neither a log nor a receipt explains a missing hit', async () => {
    vi.useFakeTimers();
    try {
      const stream = fakeStream();
      const publicClient = { getTransactionReceipt: async () => { throw new Error('429 too many requests'); } } as never;
      const sender = createChainHitSender({ wallet: {} as never, publicClient, address: ADDRESS, sessionId: 7n, hasHitBefore: true, hits: stream, confirmTimeoutMs: 500 });
      const settled = sender.confirm(HASH).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(500);
      expect(((await settled) as Error).message).toMatch(/no Hit log.*429 too many requests/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still lands the hit when the one-off receipt read fails, warning about the missing gas figure', async () => {
    const stream = fakeStream();
    const warn = vi.fn();
    const publicClient = { getTransactionReceipt: async () => { throw new Error('429'); } } as never;
    const sender = createChainHitSender({ wallet: {} as never, publicClient, address: ADDRESS, sessionId: 7n, hasHitBefore: false, hits: stream, warn });
    const p = sender.confirm(HASH);
    stream.emit({ txHash: HASH, sessionId: 7n, blockNumber: 123n, step: 13, on: true });
    await expect(p).resolves.toEqual({ blockNumber: 123n, step: 13, on: true, gasUsed: 0n });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('429'));
  });
});

describe('createHitLogStream (review M4)', () => {
  type WatchArgs = { onLogs: (logs: Log[]) => void; onError?: (e: Error) => void; poll?: boolean; pollingInterval?: number; args?: { sessionId?: bigint } };
  function fakeClient() {
    const calls: Array<WatchArgs & { active: boolean }> = [];
    const client = {
      watchContractEvent: vi.fn((args: WatchArgs) => {
        const c = { ...args, active: true };
        calls.push(c);
        return () => {
          c.active = false;
        };
      }),
    };
    return { client, calls, get current() { const c = calls.filter((x) => x.active).at(-1); if (!c) throw new Error('no active watch'); return c; } };
  }

  it('subscribes over ws for this session, decodes Hit logs, and falls back to 300 ms http polling when the socket fails', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const warn = vi.fn();
    const stream = createHitLogStream({ ws: ws.client as never, http: http.client as never, address: ADDRESS, sessionId: 7n, warn });
    const seen: SeenHit[] = [];
    stream.onHit((h) => seen.push(h));
    expect(ws.current.args?.sessionId).toBe(7n);
    expect(ws.current.poll).not.toBe(true);
    ws.current.onLogs([{ ...hitLog(7n, 13, 2, 0, true), args: { sessionId: 7n, player: PLAYER, blockNumber: 123n, step: 13, track: 2, note: 0, on: true } } as never]);
    expect(seen).toEqual([{ txHash: HASH, sessionId: 7n, blockNumber: 123n, step: 13, on: true }]);
    ws.current.onError?.(new Error('socket closed'));
    expect(http.current.poll).toBe(true);
    expect(http.current.pollingInterval).toBe(300);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('socket closed'));
    stream.stop();
    expect(http.calls.every((c) => !c.active)).toBe(true);
  });

  it('retries the socket every 30 s while polling and drops the poller once logs flow over it again (review L4)', () => {
    vi.useFakeTimers();
    try {
      const ws = fakeClient();
      const http = fakeClient();
      const stream = createHitLogStream({ ws: ws.client as never, http: http.client as never, address: ADDRESS, sessionId: 7n, warn: () => undefined, wsRetryIntervalMs: 30_000 });
      const seen: SeenHit[] = [];
      stream.onHit((h) => seen.push(h));
      ws.current.onError?.(new Error('socket closed'));
      expect(http.calls.filter((c) => c.active)).toHaveLength(1);
      vi.advanceTimersByTime(30_000);
      expect(ws.calls).toHaveLength(2);
      ws.current.onError?.(new Error('still down'));
      expect(http.calls.filter((c) => c.active)).toHaveLength(1);
      vi.advanceTimersByTime(30_000);
      expect(ws.calls).toHaveLength(3);
      ws.current.onLogs([{ ...hitLog(7n, 1, 0, 0, true), args: { sessionId: 7n, player: PLAYER, blockNumber: 200n, step: 1, track: 0, note: 0, on: true } } as never]);
      expect(seen).toHaveLength(1);
      expect(http.calls.every((c) => !c.active)).toBe(true);
      stream.stop();
      vi.advanceTimersByTime(60_000);
      expect(ws.calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls directly when there is no ws client', () => {
    const http = fakeClient();
    const stream = createHitLogStream({ ws: null, http: http.client as never, address: ADDRESS, sessionId: 7n, warn: () => undefined });
    expect(http.current.poll).toBe(true);
    stream.stop();
  });
});

describe('chain identity adapter', () => {
  it('registers with a fixed gas limit and decodes the Registered event', async () => {
    const writeContract = vi.fn(async () => HASH);
    const registry = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;
    const topics = encodeEventTopics({ abi: erc8004IdentityAbi, eventName: 'Registered', args: { agentId: 42n, owner: PLAYER } });
    const data = encodeAbiParameters([{ type: 'string' }], ['data:application/json;base64,e30=']);
    const log = { address: registry, topics, data, blockNumber: 5n, transactionHash: HASH, logIndex: 0, blockHash: HASH, transactionIndex: 0, removed: false } as Log;
    const identity = createChainIdentity({
      wallet: { writeContract } as never,
      http: { getCode: async () => '0x6080', waitForTransactionReceipt: async () => ({ status: 'success', logs: [log] }) } as never,
    });
    await expect(identity.getCode(registry)).resolves.toBe('0x6080');
    await expect(identity.register(registry, 'data:x')).resolves.toBe(HASH);
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'register', args: ['data:x'], gas: REGISTER_GAS_LIMIT }));
    await expect(identity.waitForRegistered(HASH)).resolves.toEqual({ agentId: 42n, txHash: HASH });
  });
});

describe('createClients', () => {
  it('derives the agent account from the key and binds clients to the selected chain', () => {
    const clients = createClients({ chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', wsUrl: null, privateKey: KEY });
    expect(clients.account.address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(clients.chain.id).toBe(31337);
    expect(clients.ws).toBeNull();
    expect(clients.wallet.chain.id).toBe(31337);
    // Review M4: viem's default 4 s poll is far too slow for 300 ms blocks, and 150 ms was ~7 rps per receipt.
    expect(clients.http.pollingInterval).toBe(300);
  });

  it('signs with the configured chain id for a chain shared does not know, never the testnet default', () => {
    const clients = createClients({ chainId: 999, rpcUrl: 'http://127.0.0.1:9999', wsUrl: null, privateKey: KEY });
    expect(clients.chain.id).toBe(999);
    expect(clients.wallet.chain.id).toBe(999);
  });
});
