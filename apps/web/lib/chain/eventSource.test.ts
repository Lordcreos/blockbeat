import { describe, expect, it, vi } from 'vitest';
import type { Address, Hash, PublicClient } from 'viem';
import { HitDecodeError, createChainEventSource, decodeHitLog, type RawHitLog } from './eventSource';

const ADDR = '0x00000000000000000000000000000000000000aa' as Address;
const PLAYER = '0x1111111111111111111111111111111111111111' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hash;

function rawLog(overrides: Partial<RawHitLog> = {}): RawHitLog {
  return {
    args: { sessionId: 1n, player: PLAYER, blockNumber: 105n, step: 5, track: 2, note: 3, on: true },
    blockNumber: 105n,
    transactionHash: TX,
    logIndex: 7,
    ...overrides,
  };
}

describe('decodeHitLog', () => {
  it('maps a strict Hit log to a HitEvent', () => {
    expect(decodeHitLog(rawLog())).toEqual({
      sessionId: 1n,
      player: PLAYER,
      blockNumber: 105n,
      step: 5,
      track: 2,
      note: 3,
      on: true,
      txHash: TX,
      logIndex: 7,
    });
  });

  it('prefers the event blockNumber when the log header is missing', () => {
    expect(decodeHitLog(rawLog({ blockNumber: null })).blockNumber).toBe(105n);
  });

  it('rejects an out-of-range track, note or step', () => {
    expect(() => decodeHitLog(rawLog({ args: { ...rawLog().args, track: 8 } }))).toThrow(HitDecodeError);
    expect(() => decodeHitLog(rawLog({ args: { ...rawLog().args, note: 32 } }))).toThrow(HitDecodeError);
    expect(() => decodeHitLog(rawLog({ args: { ...rawLog().args, step: 16 } }))).toThrow(HitDecodeError);
  });

  it('rejects a log without a transaction hash or log index (pending log)', () => {
    expect(() => decodeHitLog(rawLog({ transactionHash: null }))).toThrow(HitDecodeError);
    expect(() => decodeHitLog(rawLog({ logIndex: null }))).toThrow(HitDecodeError);
  });
});

type WatchArgs = {
  address: Address;
  eventName: string;
  args: { sessionId: bigint };
  strict: boolean;
  poll?: boolean;
  pollingInterval?: number;
  onLogs: (logs: RawHitLog[]) => void;
  onError?: (e: Error) => void;
};

function fakeClient(reads: Record<string, unknown> = {}) {
  const watches: Array<WatchArgs & { active: boolean }> = [];
  const readContract = vi.fn(async (args: { functionName: string; args: unknown[] }) => {
    if (!(args.functionName in reads)) throw new Error(`unexpected read ${args.functionName}`);
    return reads[args.functionName];
  });
  const client = {
    readContract,
    watchContractEvent: vi.fn((args: WatchArgs) => {
      const w = { ...args, active: true };
      watches.push(w);
      return () => {
        w.active = false;
      };
    }),
  } as unknown as PublicClient;
  return {
    client,
    readContract,
    watches,
    get current() {
      const w = watches.filter((x) => x.active).at(-1);
      if (!w) throw new Error('no active watch');
      return w;
    },
  };
}

describe('createChainEventSource', () => {
  it('reads the pattern with readContract', async () => {
    const words = Array.from({ length: 16 }, (_, i) => BigInt(i));
    const http = fakeClient({ pattern: words });
    const source = createChainEventSource({ ws: null, http: http.client, address: ADDR });
    const p = await source.readPattern(3n);
    expect(p).toEqual(words);
    expect(http.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: ADDR, functionName: 'pattern', args: [3n] }),
    );
  });

  it('reads the session and returns null when it does not exist', async () => {
    const http = fakeClient({
      getSession: {
        startBlock: 100n,
        host: PLAYER,
        finalized: false,
        hitCount: 4n,
        tokenId: 0n,
        parentSessionId: 0n,
        tipPool: 5n,
      },
    });
    const source = createChainEventSource({ ws: null, http: http.client, address: ADDR });
    expect(await source.readSession(3n)).toEqual({
      sessionId: 3n,
      startBlock: 100n,
      host: PLAYER,
      finalized: false,
      hitCount: 4n,
      tokenId: 0n,
      parentSessionId: 0n,
      tipPool: 5n,
    });
    const empty = fakeClient({
      getSession: {
        startBlock: 0n,
        host: '0x0000000000000000000000000000000000000000',
        finalized: false,
        hitCount: 0n,
        tokenId: 0n,
        parentSessionId: 0n,
        tipPool: 0n,
      },
    });
    const source2 = createChainEventSource({ ws: null, http: empty.client, address: ADDR });
    expect(await source2.readSession(3n)).toBeNull();
  });

  it('watches Hit logs over ws filtered by session and decodes them', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainEventSource({ ws: ws.client, http: http.client, address: ADDR });
    const hits: unknown[] = [];
    source.watchHits({ sessionId: 1n, mode: 'ws', onHits: (h) => hits.push(...h), onError: () => undefined });
    expect(ws.current.eventName).toBe('Hit');
    expect(ws.current.args).toEqual({ sessionId: 1n });
    expect(ws.current.strict).toBe(true);
    expect(ws.current.poll).not.toBe(true);
    expect(http.watches).toHaveLength(0);
    ws.current.onLogs([rawLog()]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ txHash: TX, step: 5 });
  });

  it('polls over http at the given interval in poll mode', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainEventSource({ ws: ws.client, http: http.client, address: ADDR });
    const off = source.watchHits({ sessionId: 1n, mode: 'poll', pollingIntervalMs: 400, onHits: () => undefined, onError: () => undefined });
    expect(http.current.poll).toBe(true);
    expect(http.current.pollingInterval).toBe(400);
    expect(ws.watches).toHaveLength(0);
    off();
    expect(http.watches.every((w) => !w.active)).toBe(true);
  });

  it('falls back to polling in ws mode when no ws client exists', () => {
    const http = fakeClient();
    const source = createChainEventSource({ ws: null, http: http.client, address: ADDR });
    source.watchHits({ sessionId: 1n, mode: 'ws', onHits: () => undefined, onError: () => undefined });
    expect(http.current.poll).toBe(true);
  });

  it('reports undecodable logs through onError and keeps the good ones', () => {
    const ws = fakeClient();
    const source = createChainEventSource({ ws: ws.client, http: fakeClient().client, address: ADDR });
    const hits: unknown[] = [];
    const errors: Error[] = [];
    source.watchHits({ sessionId: 1n, mode: 'ws', onHits: (h) => hits.push(...h), onError: (e) => errors.push(e) });
    ws.current.onLogs([rawLog({ args: { ...rawLog().args, track: 9 } }), rawLog()]);
    expect(hits).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HitDecodeError);
  });

  it('forwards transport errors', () => {
    const ws = fakeClient();
    const source = createChainEventSource({ ws: ws.client, http: fakeClient().client, address: ADDR });
    const errors: Error[] = [];
    source.watchHits({ sessionId: 1n, mode: 'ws', onHits: () => undefined, onError: (e) => errors.push(e) });
    ws.current.onError?.(new Error('socket closed'));
    expect(errors.map((e) => e.message)).toEqual(['socket closed']);
  });

  it('watches Tipped logs for the session over ws and decodes them (W12)', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainEventSource({ ws: ws.client, http: http.client, address: ADDR });
    const tips: unknown[] = [];
    const errors: Error[] = [];
    const watchTips = source.watchTips;
    expect(watchTips).toBeDefined();
    watchTips?.({ sessionId: 3n, mode: 'ws', onTips: (t) => tips.push(...t), onError: (e) => errors.push(e) });
    expect(ws.current.eventName).toBe('Tipped');
    expect(ws.current.args).toEqual({ sessionId: 3n });
    expect(ws.current.strict).toBe(true);
    const log = {
      args: { sessionId: 3n, from: '0x2222222222222222222222222222222222222222', amount: 5_000_000_000_000_000n },
      blockNumber: 900n,
      transactionHash: TX,
      logIndex: 1,
    };
    (ws.current.onLogs as unknown as (logs: unknown[]) => void)([log, { ...log, transactionHash: null }]);
    expect(tips).toEqual([
      { sessionId: 3n, from: '0x2222222222222222222222222222222222222222', amountWei: 5_000_000_000_000_000n, blockNumber: 900n, txHash: TX, logIndex: 1 },
    ]);
    expect(errors).toHaveLength(1);
  });

  it('polls Tipped logs over http in poll mode (W12)', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainEventSource({ ws: ws.client, http: http.client, address: ADDR });
    const off = source.watchTips?.({ sessionId: 3n, mode: 'poll', pollingIntervalMs: 400, onTips: () => undefined, onError: () => undefined });
    expect(http.current.eventName).toBe('Tipped');
    expect(http.current.poll).toBe(true);
    off?.();
    expect(http.watches.every((w) => !w.active)).toBe(true);
  });
});

describe('createChainEventSource history (W13)', () => {
  function historyClient(logs: RawHitLog[], head = 1_000n) {
    const getContractEvents = vi.fn(async () => logs);
    const getBlockNumber = vi.fn(async () => head);
    const client = { getContractEvents, getBlockNumber } as unknown as PublicClient;
    return { client, getContractEvents, getBlockNumber };
  }

  it('reads a Hit range with getContractEvents, strict, filtered by session and player', async () => {
    const h = historyClient([rawLog(), rawLog({ logIndex: 8 })]);
    const source = createChainEventSource({ ws: null, http: h.client, address: ADDR });
    const range = await source.readHits?.({ sessionId: 1n, fromBlock: 10n, toBlock: 20n, player: PLAYER });
    expect(h.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ address: ADDR, eventName: 'Hit', args: { sessionId: 1n, player: PLAYER }, fromBlock: 10n, toBlock: 20n, strict: true }),
    );
    expect(range?.hits.map((x) => x.logIndex)).toEqual([7, 8]);
    expect(range?.decodeErrors).toBe(0);
  });

  it('omits the player filter when none is given', async () => {
    const h = historyClient([]);
    const source = createChainEventSource({ ws: null, http: h.client, address: ADDR });
    await source.readHits?.({ sessionId: 1n, fromBlock: 10n, toBlock: 20n });
    expect(h.getContractEvents).toHaveBeenCalledWith(expect.objectContaining({ args: { sessionId: 1n } }));
  });

  it('counts undecodable logs instead of failing the range', async () => {
    const h = historyClient([rawLog(), rawLog({ args: { ...rawLog().args, track: 9 } })]);
    const source = createChainEventSource({ ws: null, http: h.client, address: ADDR });
    const range = await source.readHits?.({ sessionId: 1n, fromBlock: 10n, toBlock: 20n });
    expect(range?.hits).toHaveLength(1);
    expect(range?.decodeErrors).toBe(1);
  });

  it('reads the head uncached', async () => {
    const h = historyClient([], 4242n);
    const source = createChainEventSource({ ws: null, http: h.client, address: ADDR });
    expect(await source.readHead?.()).toBe(4242n);
    expect(h.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
  });
});
