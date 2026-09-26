import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrowdStatus } from './manager';

const idle: CrowdStatus = { running: false, stopping: false, sessionId: null, mode: null, players: null, minutes: null, pid: null, startedAt: null, lines: [], bar: null, bars: null, playersActive: null, playersTotal: null, notesSent: null, notesConfirmed: null, onStepPct: null, monSpent: null, lastExit: null };
const crowdStatusRequest = vi.fn(async (): Promise<CrowdStatus> => idle);
const crowdStartRequest = vi.fn(async (): Promise<CrowdStatus> => ({ ...idle, running: true, sessionId: '3', mode: 'headless' }));
const crowdStopRequest = vi.fn(async (): Promise<CrowdStatus> => ({ ...idle, running: true, stopping: true }));
vi.mock('./client', () => ({ crowdStatusRequest, crowdStartRequest, crowdStopRequest }));
vi.mock('../host/client', async (orig) => ({ ...(await orig<typeof import('../host/client')>()), loadHostSecret: () => 'top' }));

const { useCrowd } = await import('./useCrowd');

describe('useCrowd (W19)', () => {
  beforeEach(() => {
    crowdStatusRequest.mockClear();
    crowdStartRequest.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not poll without a host secret', async () => {
    const { result } = renderHook(() => useCrowd(false, 10));
    await new Promise((r) => setTimeout(r, 30));
    expect(crowdStatusRequest).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
  });

  it('polls the status and starts / stops the crowd', async () => {
    const { result } = renderHook(() => useCrowd(true, 10));
    await waitFor(() => expect(result.current.status).toEqual(idle));
    await act(() => result.current.start(3n, 'visible'));
    expect(crowdStartRequest).toHaveBeenCalledWith('top', { sessionId: 3n, mode: 'visible' });
    await act(() => result.current.stop());
    expect(crowdStopRequest).toHaveBeenCalledWith('top');
  });

  it('reports a failed start with its code', async () => {
    crowdStartRequest.mockRejectedValueOnce(Object.assign(new Error('x'), {}));
    const { result } = renderHook(() => useCrowd(true, 1000));
    await act(() => result.current.start(3n, 'headless'));
    expect(result.current.error).toMatchObject({ code: 'NETWORK' });
  });
});
