import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { createSimulator } from './mock/simulator';
import { loadOrCreateBurner } from './burner';
import { createRuntime, type BlockbeatRuntime } from './runtime';

let runtime: BlockbeatRuntime;
vi.mock('./runtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./runtime')>();
  return { ...mod, getRuntime: () => runtime };
});

const { MAX_DRIP_ATTEMPTS, useBalance, useBlockClock, useBurner, useDrip, useEventFeed, useHitSender, useTopUp } = await import('./hooks');

const TX = `0x${'cd'.repeat(32)}` as Hash;

describe('hooks (mock runtime)', () => {
  beforeEach(() => {
    const simulator = createSimulator({ startBlock: 100n, blockMs: 20 });
    runtime = createRuntime({ mode: 'mock', simulator, burner: loadOrCreateBurner({ storage: null }) });
  });
  afterEach(() => {
    runtime.clock.stop();
    runtime.simulator?.stop();
    vi.unstubAllGlobals();
  });

  it('useBlockClock advances with the simulator and derives the step from startBlock', async () => {
    const { result } = renderHook(() => useBlockClock(100n));
    expect(result.current.source).toBe('mock');
    await waitFor(() => expect(result.current.currentBlock).toBeGreaterThanOrEqual(103n));
    expect(result.current.currentStep).toBe(Number((result.current.currentBlock - 100n) % 16n));
    expect(result.current.measuredBlockMs).toBeGreaterThan(0);
  });

  it('useBalance reads the burner balance, estimates notes left and refreshes on demand (W12)', async () => {
    const address = runtime.burner().address;
    runtime.creditDrip(address, 300_000_000_000_000_000n);
    const { result, rerender } = renderHook(({ landed }: { landed: boolean }) => useBalance(address, 7n, true, landed), { initialProps: { landed: false } });
    await waitFor(() => expect(result.current.balanceWei).toBe(300_000_000_000_000_000n));
    expect(result.current.notesLeft).toBe(27);
    expect(result.current.level).toBe('ok');
    await act(async () => {
      const held = runtime.acquireHitSender(7n);
      await held.sender.send(7n, 3, 4);
      held.release();
    });
    // A landed note means the next one is on the 100k tier, even before the receipt flips the flag.
    rerender({ landed: true });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.balanceWei).toBe(279_600_000_000_000_000n));
    expect(result.current.notesLeft).toBe(26);
    expect(result.current.error).toBeNull();
  });

  it('useBalance stays empty while disabled or for an unfunded mock wallet (W12)', async () => {
    const address = runtime.burner().address;
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useBalance(address, 7n, on), { initialProps: { on: false } });
    expect(result.current.balanceWei).toBeNull();
    rerender({ on: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.balanceWei).toBeNull();
    expect(result.current.level).toBeNull();
  });

  it('useBalance reports a failed read instead of hiding it (W12)', async () => {
    const address = runtime.burner().address;
    runtime.readBalance = async () => {
      throw new Error('429 Too Many Requests');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useBalance(address, 7n, true));
    await waitFor(() => expect(result.current.error).toMatch(/429/));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('useBurner returns the address and never the account', async () => {
    const { result } = renderHook(() => useBurner());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.address).toBe(runtime.burner().address);
    expect(result.current?.restored).toBe(false);
    expect(Object.keys(result.current ?? {})).toEqual(['address', 'restored', 'persisted']);
  });

  it('useBurner reports whether the key survived storage so the join page can warn about private mode (review L2)', async () => {
    const { result } = renderHook(() => useBurner());
    await waitFor(() => expect(result.current).not.toBeNull());
    // The test runtime keeps the burner in memory only (storage: null).
    expect(result.current?.persisted).toBe(false);
    expect(runtime.burner().persisted).toBe(false);
  });

  it('useEventFeed reads the session, connects and reports hits', async () => {
    const { result } = renderHook(() => useEventFeed(7n));
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.session?.sessionId).toBe(7n);
    await act(async () => {
      const held = runtime.acquireHitSender(7n);
      await held.sender.send(7n, 3, 4);
      held.release();
    });
    await waitFor(() => expect(result.current.hitCount).toBe(1));
    expect(result.current.lastHit?.track).toBe(3);
    expect(result.current.error).toBeNull();
  });

  it('useEventFeed reports tips: pool, count and the last Tipped event (W12)', async () => {
    const { result } = renderHook(() => useEventFeed(9n));
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.tipCount).toBe(0);
    expect(result.current.lastTip).toBeNull();
    await act(async () => {
      const held = runtime.acquireHitSender(9n);
      await held.sender.send(9n, 1, 0);
      held.release();
      const tipper = runtime.acquireTipSender(9n);
      await tipper.sender.send(9n);
      tipper.release();
    });
    await waitFor(() => expect(result.current.tipCount).toBe(1));
    // W21b: the pool keeps the players' 80 %; raised counts the whole tip, host share included.
    expect(result.current.tipPoolWei).toBe(4_000_000_000_000_000n);
    expect(result.current.raisedWei).toBe(5_000_000_000_000_000n);
    expect(result.current.tips.map((t) => t.amountWei)).toEqual([5_000_000_000_000_000n]);
    expect(result.current.lastTip?.amountWei).toBe(5_000_000_000_000_000n);
  });

  it('useEventFeed ignores a late failure from a previous session id', async () => {
    let rejectStart: (e: Error) => void = () => undefined;
    const slowFeed = {
      ...runtime.acquireFeed(1n).feed,
      start: () => new Promise<void>((_, reject) => (rejectStart = reject)),
    };
    const original = runtime.acquireFeed;
    runtime.acquireFeed = (id: bigint) => (id === 1n ? { feed: slowFeed, release: () => undefined } : original.call(runtime, id));
    const { result, rerender } = renderHook(({ id }: { id: bigint }) => useEventFeed(id), { initialProps: { id: 1n } });
    rerender({ id: 2n });
    await waitFor(() => expect(result.current.connected).toBe(true));
    await act(async () => {
      rejectStart(new Error('rpc down for session 1'));
      await Promise.resolve();
    });
    expect(result.current.session?.sessionId).toBe(2n);
    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('useHitSender releases its hold on unmount', async () => {
    const { result, unmount } = renderHook(() => useHitSender(3n));
    await waitFor(() => expect(result.current.pending).toBe(0));
    const feed = runtime.acquireFeed(3n);
    await feed.feed.start();
    feed.release();
    expect(feed.feed.getState().connected).toBe(true); // still held by the hook
    unmount();
    expect(feed.feed.getState().connected).toBe(false);
  });

  it('useEventFeed with a null session stays idle', () => {
    const { result } = renderHook(() => useEventFeed(null));
    expect(result.current.session).toBeNull();
    expect(result.current.connected).toBe(false);
  });

  it('useHitSender sends through the runtime and tracks pending', async () => {
    const { result } = renderHook(() => useHitSender(9n));
    let p: ReturnType<typeof result.current.send> | null = null;
    act(() => {
      p = result.current.send(0, 1);
    });
    await waitFor(() => expect(result.current.pending).toBe(1));
    const receipt = await p;
    expect(receipt).toMatchObject({ on: true, step: expect.any(Number) });
    await waitFor(() => expect(result.current.pending).toBe(0));
  });

  it('useHitSender rejects when there is no session', async () => {
    const { result } = renderHook(() => useHitSender(null));
    await expect(result.current.send(0, 1)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('useDrip posts the address once and exposes the result', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ txHash: TX, track: 2, alreadyFunded: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ a }: { a: `0x${string}` | null }) => useDrip(a), {
      initialProps: { a: '0x1111111111111111111111111111111111111111' as `0x${string}` | null },
    });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.drip).toEqual({ txHash: TX, track: 2, alreadyFunded: false });
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/drip');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ address: '0x1111111111111111111111111111111111111111' });
    rerender({ a: '0x1111111111111111111111111111111111111111' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('W19: useDrip sends the session for the room cap and reports a full room', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'ROOM_FULL', message: 'the room is full: 20 players are already funded in this session' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDrip('0x1111111111111111111111111111111111111111', 12n));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ address: '0x1111111111111111111111111111111111111111', sessionId: '12' });
    expect(result.current.roomFull).toBe(true);
    expect(result.current.error).toMatch(/ROOM_FULL/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('useDrip keeps loading until the runtime sees the balance, so pads never enable before the drip is spendable (review C3)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ txHash: TX, track: 2, alreadyFunded: false }), { status: 200 })));
    let seeFunds: (ok: boolean) => void = () => undefined;
    const waitForFunds = vi.fn(() => new Promise<boolean>((r) => (seeFunds = r)));
    runtime = { ...runtime, waitForFunds };
    const { result } = renderHook(() => useDrip('0x1111111111111111111111111111111111111111'));
    await waitFor(() => expect(waitForFunds).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111'));
    expect(result.current.loading).toBe(true);
    act(() => seeFunds(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.drip).toEqual({ txHash: TX, track: 2, alreadyFunded: false });
  });

  it('useDrip skips the balance wait when the address was already funded or the drip was mocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ txHash: null, track: 2, alreadyFunded: true }), { status: 200 })));
    const waitForFunds = vi.fn(async () => true);
    runtime = { ...runtime, waitForFunds };
    const { result } = renderHook(() => useDrip('0x1111111111111111111111111111111111111111'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(waitForFunds).not.toHaveBeenCalled();
  });

  it('useDrip still exposes the drip when the balance check fails, with a warning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ txHash: TX, track: 2, alreadyFunded: false }), { status: 200 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runtime = { ...runtime, waitForFunds: vi.fn(async () => { throw new Error('429'); }) };
    const { result } = renderHook(() => useDrip('0x1111111111111111111111111111111111111111'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.drip).toEqual({ txHash: TX, track: 2, alreadyFunded: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('429'));
    warn.mockRestore();
  });

  it('useDrip surfaces the API error code and message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'DRIP_FAILED', message: 'drip transaction failed' } }), { status: 502 })),
    );
    const { result } = renderHook(() => useDrip('0x1111111111111111111111111111111111111111'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.drip).toBeNull();
    expect(result.current.error).toBe('DRIP_FAILED: drip transaction failed');
    expect(result.current.retryInSeconds).toBeNull();
  });

  it('useDrip waits Retry-After on a 429 with a countdown and re-POSTs by itself (review C4, client side)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }), { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ txHash: null, track: 2, alreadyFunded: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDrip('0x1111111111111111111111111111111111111111'));
    await waitFor(() => expect(result.current.retryInSeconds).toBe(1));
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 3_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.drip).toEqual({ txHash: null, track: 2, alreadyFunded: true });
    expect(result.current.retryInSeconds).toBeNull();
  });

  it('useDrip gives up after repeated 429s with the last error, never a hot loop', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }), { status: 429, headers: { 'retry-after': '0' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDrip('0x1111111111111111111111111111111111111111'));
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 8_000 });
    expect(result.current.error).toBe('RATE_LIMITED: slow down');
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(MAX_DRIP_ATTEMPTS);
    expect(fetchMock.mock.calls.length).toBe(MAX_DRIP_ATTEMPTS);
  }, 10_000);

  it('useDrip exposes its funding phase: requesting, then a settling countdown, then done (W12)', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (answer = r))));
    let seeFunds: (ok: boolean) => void = () => undefined;
    runtime = { ...runtime, waitForFunds: vi.fn(() => new Promise<boolean>((r) => (seeFunds = r))) };
    const { result } = renderHook(() => useDrip('0x1111111111111111111111111111111111111111'));
    await waitFor(() => expect(result.current.phase).toEqual({ kind: 'requesting' }));
    act(() => answer(new Response(JSON.stringify({ txHash: TX, track: 2, alreadyFunded: false }), { status: 200 })));
    await waitFor(() => expect(result.current.phase?.kind).toBe('settling'));
    const phase = result.current.phase;
    expect(phase?.kind === 'settling' && phase.until > Date.now()).toBe(true);
    act(() => seeFunds(true));
    await waitFor(() => expect(result.current.phase).toBeNull());
    expect(result.current.loading).toBe(false);
  });

  it('useTopUp posts { address, topUp: true }, waits for the balance to rise and reports top-ups left (W12)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ txHash: TX, track: 2, alreadyFunded: false, topUp: true, topUpsLeft: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const waitForFunds = vi.fn(async () => true);
    runtime = { ...runtime, waitForFunds, readBalance: vi.fn(async () => 4_000_000_000_000_000n) };
    const { result } = renderHook(() => useTopUp('0x1111111111111111111111111111111111111111'));
    expect(result.current.phase).toBeNull();
    let ok = false;
    await act(async () => {
      ok = await result.current.topUp();
    });
    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ address: '0x1111111111111111111111111111111111111111', topUp: true });
    expect(waitForFunds).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111', { above: 4_000_000_000_000_000n });
    expect(result.current.topUpsLeft).toBe(1);
    expect(result.current.phase).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('useTopUp credits the simulator in mock mode and surfaces a refusal code (W12)', async () => {
    const credit = vi.fn();
    runtime = { ...runtime, creditDrip: credit, readBalance: vi.fn(async () => null) };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ txHash: null, track: 2, alreadyFunded: false, topUp: true, topUpsLeft: 0 }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'TOPUP_LIMIT_REACHED', message: 'this wallet already had 2 top-ups' } }), { status: 409 })),
    );
    const { result } = renderHook(() => useTopUp('0x1111111111111111111111111111111111111111'));
    await act(async () => {
      await result.current.topUp();
    });
    expect(credit).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111', 300_000_000_000_000_000n);
    expect(result.current.topUpsLeft).toBe(0);
    let ok = true;
    await act(async () => {
      ok = await result.current.topUp();
    });
    expect(ok).toBe(false);
    expect(result.current.error).toEqual({ code: 'TOPUP_LIMIT_REACHED', message: 'this wallet already had 2 top-ups' });
  });

  it('useTopUp retries a 429 with the same countdown as the first drip (W12)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }), { status: 429, headers: { 'retry-after': '1' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ txHash: null, track: 2, alreadyFunded: false, topUp: true, topUpsLeft: 1 }), { status: 200 })),
    );
    runtime = { ...runtime, readBalance: vi.fn(async () => null) };
    const { result } = renderHook(() => useTopUp('0x1111111111111111111111111111111111111111'));
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = result.current.topUp();
    });
    await waitFor(() => expect(result.current.phase).toEqual({ kind: 'retrying', seconds: 1 }));
    await act(async () => {
      expect(await done).toBe(true);
    });
    expect(result.current.phase).toBeNull();
  });

  it('useDrip reports network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const { result } = renderHook(() => useDrip('0x1111111111111111111111111111111111111111'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('Failed to fetch');
  });

  it('useDrip does nothing without an address', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDrip(null));
    expect(result.current).toEqual({ drip: null, loading: false, error: null, retryInSeconds: null, phase: null, roomFull: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
