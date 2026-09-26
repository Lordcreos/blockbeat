import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulator } from '../mock/simulator';
import { loadOrCreateBurner } from '../burner';
import { createRuntime, type BlockbeatRuntime } from '../runtime';

let runtime: BlockbeatRuntime;
vi.mock('../runtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../runtime')>();
  return { ...mod, getRuntime: () => runtime };
});

const { isMockRuntime, markMockFinalized, useHostTips, useTipShare } = await import('./claims');

const TIP = 10_000_000_000_000_000n;

async function playAndTip(sessionId: bigint): Promise<void> {
  const hit = runtime.acquireHitSender(sessionId);
  await hit.sender.send(sessionId, 0, 0);
  hit.release();
  const tip = runtime.acquireTipSender(sessionId);
  await tip.sender.send(sessionId, TIP);
  tip.release();
}

describe('claim hooks (W21b, mock runtime)', () => {
  beforeEach(() => {
    const simulator = createSimulator({ startBlock: 100n, blockMs: 20 });
    runtime = createRuntime({ mode: 'mock', simulator, burner: loadOrCreateBurner({ storage: null }), tipper: loadOrCreateBurner({ storage: null }) });
  });
  afterEach(() => {
    runtime.clock.stop();
    runtime.simulator?.stop();
    vi.unstubAllGlobals();
  });

  it('useHostTips reads the host share when enabled and re-reads when a tip lands', async () => {
    const { result, rerender } = renderHook(({ on, tips }: { on: boolean; tips: number }) => useHostTips(3n, on, tips), { initialProps: { on: false, tips: 0 } });
    expect(result.current.claimableWei).toBeNull();
    rerender({ on: true, tips: 0 });
    await waitFor(() => expect(result.current.claimableWei).toBe(0n));
    await act(async () => playAndTip(3n));
    rerender({ on: true, tips: 1 });
    await waitFor(() => expect(result.current.claimableWei).toBe(TIP / 5n));
  });

  it('useHostTips claims through the host route and, in mock mode, from the simulator', async () => {
    await playAndTip(4n);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: '4', amountWei: '0', txHash: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useHostTips(4n, true, 1));
    await waitFor(() => expect(result.current.claimableWei).toBe(TIP / 5n));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.claim('secret');
    });
    expect(outcome).toEqual({ amountWei: TIP / 5n, txHash: null });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/session/claim-host');
    await waitFor(() => expect(result.current.claimableWei).toBe(0n));
  });

  it('useTipShare reads nothing before finalize, then claims the player share once', async () => {
    await playAndTip(5n);
    const address = runtime.burner().address;
    const { result, rerender } = renderHook(({ fin }: { fin: boolean }) => useTipShare(5n, address, fin), { initialProps: { fin: false } });
    expect(result.current.claimableWei).toBeNull();
    markMockFinalized(5n, 5n);
    rerender({ fin: true });
    await waitFor(() => expect(result.current.claimableWei).toBe((TIP * 4n) / 5n));
    await act(async () => result.current.claim());
    expect(result.current.state).toEqual({ kind: 'claimed', amountWei: (TIP * 4n) / 5n, txHash: null });
    expect(result.current.claimableWei).toBe(0n);
    await act(async () => result.current.claim());
    expect(result.current.state.kind).toBe('failed');
  });

  it('isMockRuntime tells the tip page to send the mock tip fields', () => {
    expect(isMockRuntime()).toBe(true);
  });
});
