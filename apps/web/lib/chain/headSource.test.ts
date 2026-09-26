import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { createChainHeadSource } from './headSource';

type WatchArgs = {
  onBlockNumber: (n: bigint) => void;
  onError?: (e: Error) => void;
  poll?: boolean;
  pollingInterval?: number;
  emitMissed?: boolean;
};

function fakeClient() {
  const calls: Array<WatchArgs & { active: boolean }> = [];
  const client = {
    watchBlockNumber: vi.fn((args: WatchArgs) => {
      const c = { ...args, active: true };
      calls.push(c);
      return () => {
        c.active = false;
      };
    }),
  } as unknown as PublicClient;
  return {
    client,
    calls,
    get current() {
      const c = calls.filter((x) => x.active).at(-1);
      if (!c) throw new Error('no active watch');
      return c;
    },
  };
}

describe('createChainHeadSource', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries the socket every 30 s while polling and drops the poller once newHeads is back (review L4)', () => {
    vi.useFakeTimers();
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainHeadSource({ ws: ws.client, http: http.client, warn: () => undefined, wsRetryIntervalMs: 30_000 });
    const heads: bigint[] = [];
    const off = source.subscribe((n) => heads.push(n), () => undefined);
    ws.current.onError?.(new Error('ws closed'));
    expect(source.kind()).toBe('poll');
    vi.advanceTimersByTime(29_999);
    expect(ws.calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ws.calls).toHaveLength(2);
    // The retried subscription fails at once: back to polling, one poller only.
    ws.current.onError?.(new Error('still down'));
    expect(source.kind()).toBe('poll');
    expect(http.calls.filter((c) => c.active)).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(ws.calls).toHaveLength(3);
    // This time the socket delivers a head: the poller is stopped and the kind is ws again.
    ws.current.onBlockNumber(50n);
    expect(source.kind()).toBe('ws');
    expect(http.calls.every((c) => !c.active)).toBe(true);
    expect(heads).toEqual([50n]);
    vi.advanceTimersByTime(60_000);
    expect(ws.calls).toHaveLength(3);
    off();
    expect(ws.calls.every((c) => !c.active)).toBe(true);
  });

  it('unsubscribe cancels a pending socket retry', () => {
    vi.useFakeTimers();
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainHeadSource({ ws: ws.client, http: http.client, warn: () => undefined, wsRetryIntervalMs: 30_000 });
    const off = source.subscribe(() => undefined, () => undefined);
    ws.current.onError?.(new Error('ws closed'));
    off();
    vi.advanceTimersByTime(60_000);
    expect(ws.calls).toHaveLength(1);
  });

  it('subscribes to newHeads over the ws client without polling', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainHeadSource({ ws: ws.client, http: http.client, warn: () => undefined });
    const heads: bigint[] = [];
    expect(source.kind()).toBe('ws');
    source.subscribe((n) => heads.push(n), () => undefined);
    expect(ws.current.poll).not.toBe(true);
    expect(http.calls).toHaveLength(0);
    ws.current.onBlockNumber(10n);
    expect(heads).toEqual([10n]);
  });

  it('falls back to http polling at 400 ms when the socket errors, reporting the error', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const warn = vi.fn();
    const source = createChainHeadSource({ ws: ws.client, http: http.client, pollingIntervalMs: 400, warn });
    const heads: bigint[] = [];
    const errors: Error[] = [];
    source.subscribe((n) => heads.push(n), (e) => errors.push(e));
    const wsWatch = ws.current;
    wsWatch.onError?.(new Error('ws closed'));
    expect(wsWatch.active).toBe(false);
    expect(source.kind()).toBe('poll');
    expect(http.current.poll).toBe(true);
    expect(http.current.pollingInterval).toBe(400);
    expect(errors.map((e) => e.message)).toEqual(['ws closed']);
    expect(warn).toHaveBeenCalledTimes(1);
    http.current.onBlockNumber(11n);
    expect(heads).toEqual([11n]);
  });

  it('reports polling errors without switching again', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainHeadSource({ ws: ws.client, http: http.client, warn: () => undefined });
    const errors: Error[] = [];
    source.subscribe(() => undefined, (e) => errors.push(e));
    ws.current.onError?.(new Error('ws closed'));
    http.current.onError?.(new Error('http 429'));
    expect(errors).toHaveLength(2);
    expect(source.kind()).toBe('poll');
    expect(http.calls.filter((c) => c.active)).toHaveLength(1);
  });

  it('unsubscribe stops whichever watcher is active', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainHeadSource({ ws: ws.client, http: http.client, warn: () => undefined });
    const off = source.subscribe(() => undefined, () => undefined);
    ws.current.onError?.(new Error('ws closed'));
    off();
    expect(http.calls.every((c) => !c.active)).toBe(true);
    expect(ws.calls.every((c) => !c.active)).toBe(true);
  });

  it('uses the http poller directly when no ws client is given', () => {
    const http = fakeClient();
    const source = createChainHeadSource({ ws: null, http: http.client, warn: () => undefined });
    source.subscribe(() => undefined, () => undefined);
    expect(source.kind()).toBe('poll');
    expect(http.current.poll).toBe(true);
  });
});
