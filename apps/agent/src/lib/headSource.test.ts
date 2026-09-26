import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainHeadSource, type WatchClient } from './headSource';

function fakeClient() {
  const calls: Array<Parameters<WatchClient['watchBlockNumber']>[0]> = [];
  const unwatch = vi.fn();
  const client: WatchClient = {
    watchBlockNumber(args) {
      calls.push(args);
      return unwatch;
    },
  };
  return { client, calls, unwatch };
}

describe('chain head source', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries the socket every 30 s while polling and returns to ws once a head arrives (review L4)', () => {
    vi.useFakeTimers();
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainHeadSource({ ws: ws.client, http: http.client, warn: () => undefined, wsRetryIntervalMs: 30_000 });
    const heads: bigint[] = [];
    const stop = source.subscribe((b) => heads.push(b), () => undefined);
    ws.calls[0]?.onError?.(new Error('boom'));
    expect(source.kind()).toBe('poll');
    vi.advanceTimersByTime(30_000);
    expect(ws.calls).toHaveLength(2);
    ws.calls[1]?.onError?.(new Error('still down'));
    expect(source.kind()).toBe('poll');
    expect(http.calls).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(ws.calls).toHaveLength(3);
    ws.calls[2]?.onBlockNumber(9n, undefined);
    expect(source.kind()).toBe('ws');
    expect(http.unwatch).toHaveBeenCalledTimes(1);
    expect(heads).toEqual([9n]);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(ws.calls).toHaveLength(3);
  });

  it('subscribes over WebSocket when a ws client is given', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const source = createChainHeadSource({ ws: ws.client, http: http.client, warn: () => undefined });
    const heads: bigint[] = [];
    source.subscribe((b) => heads.push(b), () => undefined);
    expect(source.kind()).toBe('ws');
    expect(ws.calls).toHaveLength(1);
    expect(http.calls).toHaveLength(0);
    ws.calls[0]?.onBlockNumber(7n, undefined);
    expect(heads).toEqual([7n]);
  });

  it('falls back to HTTP polling when the socket errors and warns once', () => {
    const ws = fakeClient();
    const http = fakeClient();
    const warn = vi.fn();
    const source = createChainHeadSource({ ws: ws.client, http: http.client, warn, pollingIntervalMs: 250 });
    const errors: Error[] = [];
    source.subscribe(() => undefined, (e) => errors.push(e));
    ws.calls[0]?.onError?.(new Error('boom'));
    expect(ws.unwatch).toHaveBeenCalledTimes(1);
    expect(source.kind()).toBe('poll');
    expect(http.calls[0]?.poll).toBe(true);
    expect(http.calls[0]?.pollingInterval).toBe(250);
    expect(errors).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('polls directly when no ws client is given', () => {
    const http = fakeClient();
    const source = createChainHeadSource({ ws: null, http: http.client, warn: () => undefined });
    const stop = source.subscribe(() => undefined, () => undefined);
    expect(source.kind()).toBe('poll');
    expect(http.calls).toHaveLength(1);
    stop();
    expect(http.unwatch).toHaveBeenCalledTimes(1);
  });
});
