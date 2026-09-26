import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyPattern, isOn, type HitEvent, type Pattern, type SessionState } from '@blockbeat/shared';
import { createEventFeed, type EventSource, type HitWatchArgs, type TipWatchArgs } from './eventFeed';
import type { TipEvent } from './types';
import { createLatencyTracker } from './latency';
import { HitDecodeError } from './chain/eventSource';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;

function hit(overrides: Partial<HitEvent> = {}): HitEvent {
  return {
    sessionId: 1n,
    player: A,
    blockNumber: 105n,
    step: 5,
    track: 2,
    note: 3,
    on: true,
    txHash: '0x' + 'ab'.repeat(32) as HitEvent['txHash'],
    logIndex: 0,
    ...overrides,
  };
}

function tip(overrides: Partial<TipEvent> = {}): TipEvent {
  return { sessionId: 1n, from: A, amountWei: 5_000_000_000_000_000n, blockNumber: 106n, txHash: `0x${'ef'.repeat(32)}`, logIndex: 0, ...overrides };
}

function fakeSource(opts: { pattern?: Pattern; session?: SessionState | null; failWs?: boolean } = {}) {
  const watches: Array<HitWatchArgs & { active: boolean }> = [];
  const tipWatches: Array<TipWatchArgs & { active: boolean }> = [];
  const chain = {
    pattern: opts.pattern ?? emptyPattern(),
    session:
      opts.session === undefined
        ? ({
            sessionId: 1n,
            startBlock: 100n,
            host: B,
            finalized: false,
            hitCount: 2n,
            tokenId: 0n,
            parentSessionId: 0n,
            tipPool: 0n,
          } satisfies SessionState)
        : opts.session,
  };
  const source: EventSource = {
    readPattern: vi.fn(async () => chain.pattern),
    readSession: vi.fn(async () => chain.session),
    watchHits(args) {
      const w = { ...args, active: true };
      watches.push(w);
      return () => {
        w.active = false;
      };
    },
    watchTips(args) {
      const w = { ...args, active: true };
      tipWatches.push(w);
      return () => {
        w.active = false;
      };
    },
  };
  return {
    source,
    watches,
    tipWatches,
    get currentTips() {
      const w = tipWatches.filter((x) => x.active).at(-1);
      if (!w) throw new Error('no active tip watch');
      return w;
    },
    /** What the chain holds now; the feed re-reads it on a resync. */
    chain,
    /** The most recent active watch. */
    get current() {
      const w = watches.filter((x) => x.active).at(-1);
      if (!w) throw new Error('no active watch');
      return w;
    },
  };
}

describe('createEventFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts disconnected with an empty pattern', () => {
    const { source } = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source });
    const s = feed.getState();
    expect(s.pattern).toEqual(emptyPattern());
    expect(s.session).toBeNull();
    expect(s.connected).toBe(false);
    expect(s.hitCount).toBe(0);
    expect(s.uniquePlayers).toBe(0);
    expect(s.hitsPerMinute).toBe(0);
    expect(s.avgLatencyMs).toBeNull();
  });

  it('reads the pattern and session on start, then subscribes over ws', async () => {
    const pattern = emptyPattern();
    pattern[3] = 1n << 5n;
    const f = fakeSource({ pattern });
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    const changes: number[] = [];
    feed.onChange((s) => changes.push(s.hitCount));
    await feed.start();
    expect(f.source.readPattern).toHaveBeenCalledWith(1n);
    expect(f.source.readSession).toHaveBeenCalledWith(1n);
    const s = feed.getState();
    expect(s.pattern[3]).toBe(1n << 5n);
    expect(s.session?.startBlock).toBe(100n);
    expect(s.hitCount).toBe(2);
    expect(s.connected).toBe(true);
    expect(f.current.mode).toBe('ws');
    expect(f.current.sessionId).toBe(1n);
    expect(changes.length).toBeGreaterThan(0);
    feed.stop();
  });

  it('applies hits to the pattern, emits them and updates the counters', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    const seen: HitEvent[] = [];
    feed.onHit((h) => seen.push(h));
    await feed.start();
    f.current.onHits([hit(), hit({ player: B, txHash: `0x${'cd'.repeat(32)}`, track: 0, note: 0, step: 1 })]);
    const s = feed.getState();
    expect(seen).toHaveLength(2);
    expect(isOn(s.pattern[5] ?? 0n, 2, 3)).toBe(true);
    expect(isOn(s.pattern[1] ?? 0n, 0, 0)).toBe(true);
    expect(s.hitCount).toBe(4);
    expect(s.uniquePlayers).toBe(2);
    expect(s.hitsPerMinute).toBe(2);
    feed.stop();
  });

  it('turns a note off when the event says on=false', async () => {
    const pattern = emptyPattern();
    pattern[5] = 1n << BigInt(2 * 32 + 3);
    const f = fakeSource({ pattern });
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    await feed.start();
    f.current.onHits([hit({ on: false })]);
    expect(isOn(feed.getState().pattern[5] ?? 0n, 2, 3)).toBe(false);
    feed.stop();
  });

  it('ignores duplicate deliveries of the same log', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    await feed.start();
    f.current.onHits([hit()]);
    f.current.onHits([hit()]);
    expect(feed.getState().hitCount).toBe(3);
    expect(isOn(feed.getState().pattern[5] ?? 0n, 2, 3)).toBe(true);
    feed.stop();
  });

  it('computes hits per minute over a rolling 60 s window', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    await feed.start();
    for (let i = 0; i < 5; i++) f.current.onHits([hit({ logIndex: i })]);
    expect(feed.getState().hitsPerMinute).toBe(5);
    vi.advanceTimersByTime(30_000);
    for (let i = 5; i < 8; i++) f.current.onHits([hit({ logIndex: i })]);
    expect(feed.getState().hitsPerMinute).toBe(8);
    vi.advanceTimersByTime(30_001);
    expect(feed.getState().hitsPerMinute).toBe(3);
    feed.stop();
  });

  it('falls back to polling when the socket fails and reports the error', async () => {
    const f = fakeSource();
    const errors: Error[] = [];
    const feed = createEventFeed({ sessionId: 1n, source: f.source, pollingIntervalMs: 400 });
    feed.onError((e) => errors.push(e));
    await feed.start();
    const ws = f.current;
    ws.onError(new Error('socket closed'));
    expect(ws.active).toBe(false);
    expect(f.current.mode).toBe('poll');
    expect(f.current.pollingIntervalMs).toBe(400);
    expect(feed.getState().connected).toBe(true);
    expect(errors.map((e) => e.message)).toEqual(['socket closed']);
    // Hits keep flowing over the poller.
    f.current.onHits([hit()]);
    expect(feed.getState().hitCount).toBe(3);
    feed.stop();
  });

  it('re-reads pattern and session on the switch to polling so hits that landed during the gap are not lost (review H2)', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    feed.onError(() => undefined);
    await feed.start();
    expect(f.source.readPattern).toHaveBeenCalledTimes(1);
    // Two hits land on chain while the socket is dead.
    const landed = emptyPattern();
    landed[2] = 1n << 3n;
    f.chain.pattern = landed;
    f.chain.session = { ...(f.chain.session as SessionState), hitCount: 4n };
    f.current.onError(new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.source.readPattern).toHaveBeenCalledTimes(2);
    expect(f.source.readSession).toHaveBeenCalledTimes(2);
    expect(feed.getState().pattern[2]).toBe(1n << 3n);
    expect(feed.getState().hitCount).toBe(4);
    expect(feed.getState().session?.hitCount).toBe(4n);
    feed.stop();
  });

  it('resyncs every 10 s while polling and retries the socket every 30 s (review H2, L4)', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source, resyncIntervalMs: 10_000, wsRetryIntervalMs: 30_000 });
    feed.onError(() => undefined);
    await feed.start();
    f.current.onError(new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.current.mode).toBe('poll');
    const reads = (f.source.readPattern as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.source.readPattern).toHaveBeenCalledTimes(reads + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.source.readPattern).toHaveBeenCalledTimes(reads + 2);
    // At 30 s the feed tries the socket again; it comes back, so the poller is dropped and the state re-read.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.current.mode).toBe('ws');
    expect(f.watches.filter((w) => w.active)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.source.readPattern).toHaveBeenCalledTimes(reads + 3);
    // Back on ws: no more periodic resyncs.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.source.readPattern).toHaveBeenCalledTimes(reads + 3);
    expect(feed.getState().connected).toBe(true);
    feed.stop();
  });

  it('goes back to polling when the retried socket fails again', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source, resyncIntervalMs: 10_000, wsRetryIntervalMs: 30_000 });
    feed.onError(() => undefined);
    await feed.start();
    f.current.onError(new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.current.mode).toBe('ws');
    f.current.onError(new Error('socket closed again'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.current.mode).toBe('poll');
    expect(f.watches.filter((w) => w.active)).toHaveLength(1);
    // And it keeps trying.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.current.mode).toBe('ws');
    feed.stop();
    expect(f.watches.every((w) => !w.active)).toBe(true);
  });

  it('never lets a slow resync overwrite a fresher one (review follow-up)', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source, resyncIntervalMs: 10_000, wsRetryIntervalMs: 100_000 });
    feed.onError(() => undefined);
    await feed.start();
    // The first resync read hangs; the interval must not start a second one on top of it.
    let releaseSlow: (p: Pattern) => void = () => undefined;
    (f.source.readPattern as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<Pattern>((r) => (releaseSlow = r)));
    f.current.onError(new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(0);
    const reads = (f.source.readPattern as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.source.readPattern).toHaveBeenCalledTimes(reads);
    const stale = emptyPattern();
    stale[0] = 1n;
    releaseSlow(stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.getState().pattern[0]).toBe(1n);
    // Once it settled, the next interval reads again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.source.readPattern).toHaveBeenCalledTimes(reads + 1);
    feed.stop();
  });

  it('keeps the current state and reports the error when a resync read fails', async () => {
    const f = fakeSource();
    const errors: Error[] = [];
    const feed = createEventFeed({ sessionId: 1n, source: f.source, resyncIntervalMs: 10_000 });
    feed.onError((e) => errors.push(e));
    await feed.start();
    f.current.onHits([hit()]);
    (f.source.readPattern as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rpc 429'));
    f.current.onError(new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.map((e) => e.message)).toEqual(['socket closed', 'rpc 429']);
    expect(feed.getState().hitCount).toBe(3);
    expect(isOn(feed.getState().pattern[5] ?? 0n, 2, 3)).toBe(true);
    feed.stop();
  });

  it('stop() clears the resync and retry timers', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source, resyncIntervalMs: 10_000, wsRetryIntervalMs: 30_000 });
    feed.onError(() => undefined);
    await feed.start();
    f.current.onError(new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(0);
    feed.stop();
    const reads = (f.source.readPattern as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.source.readPattern).toHaveBeenCalledTimes(reads);
    expect(f.watches.every((w) => !w.active)).toBe(true);
  });

  it('counts undecodable Hit logs in the state instead of only warning, without switching mode (review L6)', async () => {
    const f = fakeSource();
    const errors: Error[] = [];
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    feed.onError((e) => errors.push(e));
    const changes: number[] = [];
    feed.onChange((s) => changes.push(s.decodeErrors));
    await feed.start();
    expect(feed.getState().decodeErrors).toBe(0);
    f.current.onError(new HitDecodeError('Hit log has track 9 out of range'));
    f.current.onError(new HitDecodeError('Hit log has note 40 out of range'));
    expect(feed.getState().decodeErrors).toBe(2);
    expect(changes.at(-1)).toBe(2);
    expect(f.current.mode).toBe('ws');
    expect(feed.getState().connected).toBe(true);
    expect(errors).toHaveLength(2);
    feed.stop();
  });

  it('marks disconnected when polling fails too', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    feed.onError(() => undefined);
    await feed.start();
    f.current.onError(new Error('ws down'));
    f.current.onError(new Error('http down'));
    expect(feed.getState().connected).toBe(false);
    feed.stop();
  });

  it('propagates a failed initial read', async () => {
    const source: EventSource = {
      readPattern: async () => {
        throw new Error('rpc 429');
      },
      readSession: async () => null,
      watchHits: () => () => undefined,
    };
    const feed = createEventFeed({ sessionId: 1n, source });
    await expect(feed.start()).rejects.toThrow('rpc 429');
    expect(feed.getState().connected).toBe(false);
  });

  it('exposes the rolling average latency reported by hit senders', async () => {
    const latency = createLatencyTracker();
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source, latency });
    const changes: Array<number | null> = [];
    feed.onChange((s) => changes.push(s.avgLatencyMs));
    await feed.start();
    latency.record(400);
    latency.record(600);
    expect(feed.getState().avgLatencyMs).toBe(500);
    expect(changes.at(-1)).toBe(500);
    feed.stop();
  });

  it('a second start() while the first is still reading shares its completion', async () => {
    let resolvePattern: (p: Pattern) => void = () => undefined;
    const source: EventSource = {
      readPattern: () => new Promise<Pattern>((r) => (resolvePattern = r)),
      readSession: async () => null,
      watchHits: () => () => undefined,
    };
    const feed = createEventFeed({ sessionId: 1n, source });
    const first = feed.start();
    const second = feed.start();
    expect(second).toBe(first);
    let settled = false;
    void second.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    resolvePattern(emptyPattern());
    await second;
    expect(feed.getState().connected).toBe(true);
    feed.stop();
  });

  it('stop() unsubscribes and start() is idempotent', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    await feed.start();
    await feed.start();
    expect(f.watches.filter((w) => w.active)).toHaveLength(1);
    feed.stop();
    expect(f.watches.filter((w) => w.active)).toHaveLength(0);
    expect(feed.getState().connected).toBe(false);
  });

  it('unsubscribes listeners', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    const seen: HitEvent[] = [];
    const off = feed.onHit((h) => seen.push(h));
    await feed.start();
    off();
    f.current.onHits([hit()]);
    expect(seen).toHaveLength(0);
    feed.stop();
  });

  it('counts tips from the pool at load (every app tip is 0.005 MON), then adds each Tipped event live (W12)', async () => {
    const f = fakeSource();
    f.chain.session = { ...(f.chain.session as SessionState), tipPool: 15_000_000_000_000_000n };
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    const seen: TipEvent[] = [];
    feed.onTip((t) => seen.push(t));
    await feed.start();
    expect(feed.getState().tipPoolWei).toBe(15_000_000_000_000_000n);
    expect(feed.getState().tipCount).toBe(3);
    expect(f.currentTips.mode).toBe('ws');
    f.currentTips.onTips([tip()]);
    f.currentTips.onTips([tip()]); // duplicate delivery
    expect(seen).toHaveLength(1);
    expect(feed.getState().tipCount).toBe(4);
    expect(feed.getState().tipPoolWei).toBe(20_000_000_000_000_000n);
    expect(feed.getState().session?.tipPool).toBe(20_000_000_000_000_000n);
  });

  it('keeps the chain pool on a resync without double counting live tips (W12)', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source, resyncIntervalMs: 1_000 });
    await feed.start();
    f.currentTips.onTips([tip()]);
    f.chain.session = { ...(f.chain.session as SessionState), tipPool: 5_000_000_000_000_000n };
    f.current.onError(new Error('socket closed')); // switch to polling: resync
    await vi.advanceTimersByTimeAsync(0);
    expect(f.currentTips.mode).toBe('poll');
    expect(feed.getState().tipPoolWei).toBe(5_000_000_000_000_000n);
    expect(feed.getState().tipCount).toBe(1);
  });

  it('reports tip watch errors without switching the hit watch (W12)', async () => {
    const f = fakeSource();
    const feed = createEventFeed({ sessionId: 1n, source: f.source });
    const errors: Error[] = [];
    feed.onError((e) => errors.push(e));
    await feed.start();
    f.currentTips.onError(new Error('tip log decode'));
    expect(errors.map((e) => e.message)).toEqual(['tip log decode']);
    expect(f.current.mode).toBe('ws');
    feed.stop();
    expect(f.tipWatches.every((w) => !w.active)).toBe(true);
  });

  it('works with a source that has no tip watch (W12)', async () => {
    const f = fakeSource();
    const withoutTips: EventSource = { readPattern: f.source.readPattern, readSession: f.source.readSession, watchHits: f.source.watchHits };
    const feed = createEventFeed({ sessionId: 1n, source: withoutTips });
    await feed.start();
    expect(feed.getState().tipCount).toBe(0);
  });
});
