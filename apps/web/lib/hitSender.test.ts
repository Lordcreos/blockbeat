import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import type { HitEvent } from '@blockbeat/shared';
import { createHitSender, HitError, type HitWriter } from './hitSender';
import { createLatencyTracker } from './latency';

const A = '0x1111111111111111111111111111111111111111' as const;
const H1 = `0x${'11'.repeat(32)}` as Hash;
const H2 = `0x${'22'.repeat(32)}` as Hash;

function hitFor(txHash: Hash, overrides: Partial<HitEvent> = {}): HitEvent {
  return {
    sessionId: 1n,
    player: A,
    blockNumber: 500n,
    step: 4,
    track: 1,
    note: 2,
    on: true,
    txHash,
    logIndex: 0,
    ...overrides,
  };
}

function fakeStream() {
  const listeners = new Set<(h: HitEvent) => void>();
  return {
    onHit(cb: (h: HitEvent) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(h: HitEvent) {
      for (const cb of listeners) cb(h);
    },
    size: () => listeners.size,
  };
}

describe('createHitSender', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends through the writer and resolves on the matching Hit log with the latency', async () => {
    const stream = fakeStream();
    const writer = vi.fn<HitWriter>(async () => H1);
    const latency = createLatencyTracker();
    const sender = createHitSender({ writer, hits: stream, latency });
    const p = sender.send(1n, 1, 2);
    expect(sender.pending()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(writer).toHaveBeenCalledWith({ sessionId: 1n, track: 1, note: 2 }, expect.objectContaining({ onRetry: expect.any(Function) }));
    vi.advanceTimersByTime(412);
    stream.emit(hitFor(H1, { blockNumber: 501n, step: 5, on: false }));
    const receipt = await p;
    expect(receipt).toEqual({ txHash: H1, blockNumber: 501n, step: 5, on: false, latencyMs: 412 });
    expect(sender.pending()).toBe(0);
    expect(latency.average()).toBe(412);
    expect(stream.size()).toBe(0);
  });

  it('ignores Hit logs for other transactions', async () => {
    const stream = fakeStream();
    const sender = createHitSender({ writer: async () => H1, hits: stream });
    const p = sender.send(1n, 1, 2);
    await vi.advanceTimersByTimeAsync(0);
    stream.emit(hitFor(H2));
    expect(sender.pending()).toBe(1);
    stream.emit(hitFor(H1));
    await expect(p).resolves.toMatchObject({ txHash: H1 });
  });

  it('resolves when the Hit log arrived before the writer returned the hash', async () => {
    const stream = fakeStream();
    let resolveHash: (h: Hash) => void = () => undefined;
    const writer: HitWriter = () => new Promise<Hash>((r) => (resolveHash = r));
    const sender = createHitSender({ writer, hits: stream });
    const p = sender.send(1n, 1, 2);
    stream.emit(hitFor(H1));
    resolveHash(H1);
    await expect(p).resolves.toMatchObject({ txHash: H1 });
  });

  it('rejects with SEND_FAILED when the writer throws and keeps the cause', async () => {
    const stream = fakeStream();
    const boom = new Error('insufficient funds');
    const sender = createHitSender({
      writer: async () => {
        throw boom;
      },
      hits: stream,
    });
    const p = sender.send(1n, 1, 2);
    await expect(p).rejects.toBeInstanceOf(HitError);
    await expect(p).rejects.toMatchObject({ code: 'SEND_FAILED', cause: boom });
    expect(sender.pending()).toBe(0);
    expect(stream.size()).toBe(0);
  });

  it('resolves on the replacement hash when the writer retried the send (review H7, M3)', async () => {
    const stream = fakeStream();
    let hooks: Parameters<HitWriter>[1] | undefined;
    const writer: HitWriter = async (_args, h) => {
      hooks = h;
      return H1;
    };
    const sender = createHitSender({ writer, hits: stream, latency: createLatencyTracker() });
    const p = sender.send(1n, 1, 2);
    await vi.advanceTimersByTimeAsync(0);
    hooks?.onRetry?.(H2);
    stream.emit(hitFor(H2));
    await expect(p).resolves.toMatchObject({ txHash: H2 });
  });

  it('fails fast with SEND_FAILED when the writer reports a revert of the current hash', async () => {
    const stream = fakeStream();
    let hooks: Parameters<HitWriter>[1] | undefined;
    const writer: HitWriter = async (_args, h) => {
      hooks = h;
      return H1;
    };
    const sender = createHitSender({ writer, hits: stream, latency: createLatencyTracker() });
    const p = sender.send(1n, 1, 2);
    const settled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    hooks?.onReverted?.(H1, 'hit reverted (0x11…); the session may be finalized or unknown');
    const err = (await settled) as HitError;
    expect(err).toBeInstanceOf(HitError);
    expect(err.code).toBe('SEND_FAILED');
    expect(err.txHash).toBe(H1);
    expect(err.message).toContain('finalized');
    expect(sender.pending()).toBe(0);
  });

  it('rejects with TIMEOUT after the deadline', async () => {
    const stream = fakeStream();
    const sender = createHitSender({ writer: async () => H1, hits: stream, timeoutMs: 15_000 });
    const p = sender.send(1n, 1, 2);
    const failure = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sender.pending()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = await failure;
    expect(err).toBeInstanceOf(HitError);
    expect((err as HitError).code).toBe('TIMEOUT');
    expect((err as HitError).txHash).toBe(H1);
    expect(sender.pending()).toBe(0);
    expect(stream.size()).toBe(0);
  });

  it('rejects invalid track or note without calling the writer', async () => {
    const stream = fakeStream();
    const writer = vi.fn<HitWriter>(async () => H1);
    const sender = createHitSender({ writer, hits: stream });
    await expect(sender.send(1n, 9 as never, 0)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sender.send(1n, 0, 32)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sender.send(1n, 0, 1.5)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(writer).not.toHaveBeenCalled();
    expect(sender.pending()).toBe(0);
  });

  it('counts several hits in flight', async () => {
    const stream = fakeStream();
    let n = 0;
    const sender = createHitSender({ writer: async () => (n++ === 0 ? H1 : H2), hits: stream });
    const p1 = sender.send(1n, 0, 0);
    const p2 = sender.send(1n, 0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.pending()).toBe(2);
    stream.emit(hitFor(H2));
    await p2;
    expect(sender.pending()).toBe(1);
    stream.emit(hitFor(H1));
    await p1;
    expect(sender.pending()).toBe(0);
  });
});
