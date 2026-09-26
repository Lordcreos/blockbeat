import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther, type Address, type Hash } from 'viem';
import { createSimulator } from '../mock/simulator';
import { loadOrCreateBurner } from '../burner';
import { createRuntime, type BlockbeatRuntime } from '../runtime';
import type { TipEvent } from '../types';
import type { TipNote } from './noteShape';
import { mergeTips, sumTips } from './tipList';

let runtime: BlockbeatRuntime;
vi.mock('../runtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../runtime')>();
  return { ...mod, getRuntime: () => runtime };
});

const { postTipNote, useSendTip, useTipNotes, useTipper, useTipperFunding } = await import('./hooks');

const TX = `0x${'ab'.repeat(32)}` as Hash;
const TX2 = `0x${'cd'.repeat(32)}` as Hash;
const FROM = '0x1111111111111111111111111111111111111111' as Address;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const NOTE: TipNote = { sessionId: '7', txHash: TX, from: FROM, amountWei: '20000000000000000', hostWei: null, poolWei: null, blockNumber: '9', name: 'Ana', message: 'hi', createdAt: 5 };

describe('tip hooks (W21b, mock runtime)', () => {
  beforeEach(() => {
    const simulator = createSimulator({ startBlock: 100n, blockMs: 20 });
    runtime = createRuntime({ mode: 'mock', simulator, burner: loadOrCreateBurner({ storage: null }), tipper: loadOrCreateBurner({ storage: null }) });
  });
  afterEach(() => {
    runtime.clock.stop();
    runtime.simulator?.stop();
    vi.unstubAllGlobals();
  });

  it('useTipper exposes the tipper burner, not the player one', async () => {
    const { result } = renderHook(() => useTipper());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.address).toBe(runtime.tipper().address);
    expect(result.current?.address).not.toBe(runtime.burner().address);
  });

  it('useTipperFunding asks the drip in tipper mode and credits the simulator in mock mode', async () => {
    const fetchMock = vi.fn(async () => json(200, { txHash: null, alreadyFunded: false, amountWei: parseEther('0.1').toString() }));
    vi.stubGlobal('fetch', fetchMock);
    const address = runtime.tipper().address;
    const { result } = renderHook(() => useTipperFunding(address, 7n));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ address, mode: 'tipper', sessionId: '7' });
    expect(runtime.simulator?.balanceOf(address)).toBe(parseEther('0.1'));
    expect(result.current.error).toBeNull();
  });

  it('useTipperFunding waits out a 429 and then reports a refusal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(503, { error: { code: 'TIPPERS_EXHAUSTED', message: 'no more tipper wallets' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useTipperFunding(FROM, 7n));
    await waitFor(() => expect(result.current.retryInSeconds).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    await waitFor(() => expect(result.current.error).toBe('TIPPERS_EXHAUSTED: no more tipper wallets'));
    expect(result.current.ready).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('useSendTip sends the picked amount from the tipper and tracks pending', async () => {
    const hit = runtime.acquireHitSender(4n);
    await hit.sender.send(4n, 0, 0);
    const { result } = renderHook(() => useSendTip(4n));
    let p: Promise<unknown> | null = null;
    act(() => {
      p = result.current.send(parseEther('0.02'));
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await expect(p).resolves.toMatchObject({ amountWei: parseEther('0.02') });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(runtime.simulator?.summary(4n)?.tips[0]?.from).toBe(runtime.tipper().address);
    hit.release();
  });

  it('useSendTip rejects without a session', async () => {
    const { result } = renderHook(() => useSendTip(null));
    await expect(result.current.send(1n)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('postTipNote retries while the node has not indexed the receipt, then returns the note', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(404, { error: { code: 'RECEIPT_NOT_FOUND', message: 'not yet' } }, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(201, { note: NOTE }));
    const sleep = vi.fn(async () => undefined);
    const out = await postTipNote({ sessionId: 7n, txHash: TX, name: 'Ana', message: 'hi' }, { fetchImpl: fetchMock, sleep });
    expect(out).toEqual({ ok: true, note: NOTE });
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ sessionId: '7', txHash: TX, name: 'Ana', message: 'hi' });
  });

  it('postTipNote gives up with the server code and never retries a refusal', async () => {
    const fetchMock = vi.fn(async () => json(422, { error: { code: 'NOT_A_TIP', message: 'no' } }));
    const out = await postTipNote({ sessionId: 7n, txHash: TX, name: null, message: null, mock: { from: FROM, amountWei: 5n } }, { fetchImpl: fetchMock, sleep: async () => undefined });
    expect(out).toEqual({ ok: false, code: 'NOT_A_TIP', message: 'no' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).mock).toEqual({ from: FROM, amountWei: '5' });
  });

  it('postTipNote reports a network failure without throwing', async () => {
    const out = await postTipNote({ sessionId: 7n, txHash: TX, name: null, message: null }, { fetchImpl: vi.fn(async () => Promise.reject(new Error('offline'))), sleep: async () => undefined, attempts: 2 });
    expect(out).toEqual({ ok: false, code: 'NETWORK', message: 'offline' });
  });

  it('useTipNotes reads the notes, drops malformed ones and polls again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { notes: [NOTE, { junk: true }] }))
      .mockResolvedValueOnce(json(200, { notes: [{ ...NOTE, txHash: TX2 }, NOTE] }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useTipNotes(7n, 1_000));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/tip-note?session=7&limit=50');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_050);
    });
    await waitFor(() => expect(result.current.notes.map((n) => n.txHash)).toEqual([TX2, TX]));
    vi.useRealTimers();
  });
});

describe('mergeTips (W21b)', () => {
  const live = (txHash: Hash, amountWei: bigint, from: Address = FROM): TipEvent => ({ sessionId: 7n, from, amountWei, blockNumber: 1n, txHash, logIndex: 0 });

  it('puts live tips without a note first, newest first, then the notes', () => {
    const lines = mergeTips([live(TX, 1n), live(TX2, 2n)], [NOTE]);
    expect(lines.map((l) => [l.txHash, l.amountWei, l.name])).toEqual([
      [TX2, 2n, null],
      [TX, 1n, 'Ana'],
    ]);
    expect(sumTips(lines)).toBe(3n);
  });

  it('uses the note amount when this tab never saw the tip, and honours the limit', () => {
    expect(mergeTips([], [NOTE])[0]?.amountWei).toBe(20_000_000_000_000_000n);
    expect(mergeTips([live(TX2, 2n)], [NOTE], 1)).toHaveLength(1);
  });
});
