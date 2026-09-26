/**
 * W13: the feed keeps the session's Hit history for the live (decaying) layer. Backfill is
 * getLogs in 100-block chunks, newest window first; backfilled hits never count as new hits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyPattern, type HitEvent, type SessionState } from '@blockbeat/shared';
import { createEventFeed, HISTORY_CHUNK_BLOCKS, RESYNC_OVERLAP_BLOCKS, type EventSource, type HitRangeQuery, type HitWatchArgs } from './eventFeed';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;

function hit(blockNumber: bigint, overrides: Partial<HitEvent> = {}): HitEvent {
  return {
    sessionId: 1n,
    player: A,
    blockNumber,
    step: Number((blockNumber - 100n) % 16n),
    track: 2,
    note: 3,
    on: true,
    txHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as HitEvent['txHash'],
    logIndex: 0,
    ...overrides,
  };
}

function historySource(opts: { startBlock?: bigint; head: bigint; logs: HitEvent[]; noHistory?: boolean }) {
  const watches: Array<HitWatchArgs & { active: boolean }> = [];
  const queries: HitRangeQuery[] = [];
  const chain = {
    head: opts.head,
    logs: [...opts.logs],
    fail: null as Error | null,
    session: {
      sessionId: 1n,
      startBlock: opts.startBlock ?? 100n,
      host: B,
      finalized: false,
      hitCount: BigInt(opts.logs.length),
      tokenId: 0n,
      parentSessionId: 0n,
      tipPool: 0n,
    } satisfies SessionState,
  };
  const source: EventSource = {
    readPattern: vi.fn(async () => emptyPattern()),
    readSession: vi.fn(async () => chain.session),
    watchHits(args) {
      const w = { ...args, active: true };
      watches.push(w);
      return () => {
        w.active = false;
      };
    },
    ...(opts.noHistory
      ? {}
      : {
          readHead: vi.fn(async () => chain.head),
          readHits: vi.fn(async (q: HitRangeQuery) => {
            queries.push(q);
            if (chain.fail) throw chain.fail;
            return {
              hits: chain.logs.filter((h) => h.blockNumber >= q.fromBlock && h.blockNumber <= q.toBlock && (!q.player || h.player === q.player)),
              decodeErrors: 0,
            };
          }),
        }),
  };
  return {
    source,
    queries,
    chain,
    get current() {
      const w = watches.filter((x) => x.active).at(-1);
      if (!w) throw new Error('no active watch');
      return w;
    },
  };
}

/** Let the background backfill run its sequential awaits. */
async function flush(): Promise<void> {
  for (let i = 0; i < 300; i++) await Promise.resolve();
}

describe('event feed history (W13)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backfills the live window newest first in 100-block chunks, silently', async () => {
    const logs = [hit(150n), hit(900n), hit(960n), hit(1000n, { logIndex: 1 })];
    const f = historySource({ head: 1000n, logs });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', lifetimeBars: 8 });
    const onHit = vi.fn();
    feed.onHit(onHit);
    expect(feed.getState().historyReady).toBe(false);
    await feed.start();
    await flush();
    expect(HISTORY_CHUNK_BLOCKS).toBe(100);
    // Window = 2 lifetimes (256) + fade (32) + overlap (16) = 304 blocks back from the head, in chunks from the head down.
    expect(f.queries.map((q) => [q.fromBlock, q.toBlock])).toEqual([
      [901n, 1000n],
      [801n, 900n],
      [701n, 800n],
      [696n, 700n],
    ]);
    const s = feed.getState();
    expect(s.hits.map((h) => h.blockNumber)).toEqual([900n, 960n, 1000n]);
    expect(s.historyReady).toBe(true);
    expect(s.historyFrom).toBe(696n);
    expect(onHit).not.toHaveBeenCalled();
    expect(s.hitCount).toBe(4); // from getSession, not bumped by the backfill
    feed.stop();
  });

  it('is bounded on an old session: 4 chunks below the head, never back to the start (coordinator)', async () => {
    const f = historySource({ startBlock: 100n, head: 100_000n, logs: [hit(99_990n), hit(200n)] });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', lifetimeBars: 8 });
    await feed.start();
    await flush();
    expect(f.queries).toHaveLength(4);
    expect(f.queries.every((q) => q.fromBlock >= 100_000n - 304n)).toBe(true);
    expect(feed.getState().hits.map((h) => h.blockNumber)).toEqual([99_990n]);
    feed.stop();
  });

  it('full history walks back to the session start after the window', async () => {
    const logs = [hit(150n), hit(420n), hit(1000n)];
    const f = historySource({ head: 1000n, logs });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'full', lifetimeBars: 8 });
    await feed.start();
    await flush();
    expect(f.queries.at(-1)?.fromBlock).toBe(100n);
    expect(f.queries.every((q) => q.toBlock - q.fromBlock < 100n)).toBe(true);
    expect(feed.getState().hits.map((h) => h.blockNumber)).toEqual([150n, 420n, 1000n]);
    expect(feed.getState().historyFrom).toBe(100n);
    feed.stop();
  });

  it('window mode on a phone filters by player', async () => {
    const logs = [hit(990n), hit(995n, { player: B })];
    const f = historySource({ head: 1000n, logs });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', historyPlayer: A, lifetimeBars: 8 });
    await feed.start();
    await flush();
    expect(f.queries.every((q) => q.player === A)).toBe(true);
    expect(feed.getState().hits.map((h) => h.player)).toEqual([A]);
    feed.stop();
  });

  it('a live hit also returned by the backfill counts and fires once', async () => {
    const landed = hit(1000n);
    const f = historySource({ head: 1000n, logs: [landed] });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', lifetimeBars: 8 });
    const onHit = vi.fn();
    feed.onHit(onHit);
    await feed.start();
    await flush();
    f.current.onHits([landed]);
    f.current.onHits([landed]);
    expect(onHit).toHaveBeenCalledTimes(1);
    expect(feed.getState().hits).toHaveLength(1);
    expect(feed.getState().hitCount).toBe(2);
    feed.stop();
  });

  it('keeps live hits in history sorted by (blockNumber, logIndex)', async () => {
    const f = historySource({ head: 1000n, logs: [] });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', lifetimeBars: 8 });
    await feed.start();
    await flush();
    f.current.onHits([hit(1003n, { logIndex: 1 }), hit(1003n, { logIndex: 0, txHash: `0x${'aa'.repeat(32)}` })]);
    f.current.onHits([hit(1001n)]);
    expect(feed.getState().hits.map((h) => `${h.blockNumber}:${h.logIndex}`)).toEqual(['1001:0', '1003:0', '1003:1']);
    feed.stop();
  });

  it('on a resync reads the gap from the last scanned block, with an overlap for a lagging node', async () => {
    const f = historySource({ head: 1000n, logs: [] });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', lifetimeBars: 8 });
    await feed.start();
    await flush();
    f.queries.length = 0;
    f.chain.head = 1050n;
    f.chain.logs.push(hit(1020n));
    f.current.onError(new Error('socket closed')); // ws → poll triggers a resync
    await flush();
    expect(RESYNC_OVERLAP_BLOCKS).toBe(16);
    expect(f.queries.map((q) => [q.fromBlock, q.toBlock])).toEqual([[985n, 1050n]]);
    expect(feed.getState().hits.map((h) => h.blockNumber)).toEqual([1020n]);
    feed.stop();
  });

  it('reports a failed backfill (never silent) and retries it on the next resync', async () => {
    const f = historySource({ head: 1000n, logs: [hit(999n)] });
    f.chain.fail = new Error('429 too many requests');
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', lifetimeBars: 8 });
    const errors: string[] = [];
    feed.onError((e) => errors.push(e.message));
    await feed.start();
    await flush();
    expect(errors.some((m) => /history backfill failed: 429/.test(m))).toBe(true);
    expect(feed.getState().historyReady).toBe(false);
    f.chain.fail = null;
    f.current.onError(new Error('socket closed'));
    await flush();
    expect(feed.getState().historyReady).toBe(true);
    expect(feed.getState().hits).toHaveLength(1);
    feed.stop();
  });

  it('requestFullHistory() extends a window feed back to the session start', async () => {
    const f = historySource({ head: 1000n, logs: [hit(300n), hit(990n)] });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', lifetimeBars: 8 });
    await feed.start();
    await flush();
    expect(feed.getState().hits).toHaveLength(1);
    feed.requestFullHistory();
    await flush();
    expect(feed.getState().hits.map((h) => h.blockNumber)).toEqual([300n, 990n]);
    expect(feed.getState().historyFrom).toBe(100n);
    feed.stop();
  });

  it('with decay off (lifetime 0) or a source without getLogs it keeps live hits only', async () => {
    const off = historySource({ head: 1000n, logs: [hit(990n)] });
    const feedOff = createEventFeed({ sessionId: 1n, source: off.source, history: 'full', lifetimeBars: 0 });
    await feedOff.start();
    await flush();
    expect(off.queries).toHaveLength(0);
    expect(feedOff.getState().historyReady).toBe(true);
    feedOff.stop();

    const bare = historySource({ head: 1000n, logs: [], noHistory: true });
    const feed = createEventFeed({ sessionId: 1n, source: bare.source, history: 'window', lifetimeBars: 8 });
    await feed.start();
    await flush();
    bare.current.onHits([hit(1001n)]);
    expect(feed.getState().hits).toHaveLength(1);
    expect(feed.getState().historyReady).toBe(true);
    feed.stop();
  });

  it('keeps a head hint from the head read and from live hits (the phone has no block clock)', async () => {
    const f = historySource({ head: 1000n, logs: [] });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', lifetimeBars: 8 });
    expect(feed.getState().headHint).toBeNull();
    await feed.start();
    await flush();
    expect(feed.getState().headHint).toEqual({ block: 1000n, atMs: 0 });
    vi.setSystemTime(900);
    f.current.onHits([hit(1003n)]);
    expect(feed.getState().headHint).toEqual({ block: 1003n, atMs: 900 });
    f.current.onHits([hit(1001n)]); // older: keeps the newer hint
    expect(feed.getState().headHint?.block).toBe(1003n);
    feed.stop();
  });

  it('a phone feed waits its initial delay before the first history read, and stop() cancels it', async () => {
    const f = historySource({ head: 1000n, logs: [hit(999n)] });
    const feed = createEventFeed({ sessionId: 1n, source: f.source, history: 'window', lifetimeBars: 8, initialSyncDelayMs: 800 });
    await feed.start();
    await flush();
    expect(f.queries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(800);
    await flush();
    expect(f.queries.length).toBeGreaterThan(0);
    feed.stop();

    const g = historySource({ head: 1000n, logs: [] });
    const other = createEventFeed({ sessionId: 1n, source: g.source, history: 'window', lifetimeBars: 8, initialSyncDelayMs: 800 });
    await other.start();
    other.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.queries).toHaveLength(0);
  });
});
