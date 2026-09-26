import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_SECRET_STORAGE_KEY } from './client';
import { useAgentDj } from './useAgentDj';

const off = { running: false, sessionId: null, pid: null, startedAt: null, lines: [], hitsSent: null, budgetLeft: null, brain: null, lastExit: null };
const on = { ...off, running: true, sessionId: '3', pid: 7, startedAt: 1, lines: ['bar 1 | sent 1 | budget 39 | brain rules'], hitsSent: 1, budgetLeft: 39, brain: 'rules' };

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('useAgentDj (W12)', () => {
  beforeEach(() => {
    window.sessionStorage.setItem(HOST_SECRET_STORAGE_KEY, 'top');
  });
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('polls the status while enabled and stops polling when disabled', async () => {
    const fetchMock = vi.fn(async () => respond(on));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useAgentDj(enabled, 30), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.status?.running).toBe(true));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    rerender({ enabled: false });
    const calls = fetchMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('never polls without a host secret (a 401 storm would lock the presenter out)', async () => {
    const fetchMock = vi.fn(async () => respond(on));
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAgentDj(false, 30));
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts and stops the DJ and reports the new status', async () => {
    const fetchMock = vi.fn(async (url: string) => respond(url.endsWith('/start') ? on : url.endsWith('/stop') ? { ...off, lastExit: 'stopped: host pressed Stop DJ' } : off));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAgentDj(true, 10_000));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    await act(async () => {
      await result.current.start(3n);
    });
    expect(result.current.status?.running).toBe(true);
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.status?.lastExit).toMatch(/Stop DJ/);
    expect(result.current.busy).toBe(false);
  });

  it('keeps the refusal as an error with its code', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/start') ? respond({ error: { code: 'AGENT_RUNNING', message: 'the DJ is already playing session 3' } }, 409) : respond(off))));
    const { result } = renderHook(() => useAgentDj(true, 10_000));
    await act(async () => {
      await result.current.start(3n);
    });
    expect(result.current.error).toEqual({ code: 'AGENT_RUNNING', status: 409, message: 'the DJ is already playing session 3' });
  });

  it('shows nothing once disabled (secret cleared after a 401), instead of a stale "On" (review)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(on)));
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useAgentDj(enabled, 10_000), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.status?.running).toBe(true));
    rerender({ enabled: false });
    expect(result.current.status).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('still reports a start refused for the secret while disabled, so the button never fails silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ error: { code: 'UNAUTHORIZED', message: 'missing or wrong host secret' } }, 401)));
    const { result } = renderHook(() => useAgentDj(false, 10_000));
    await act(async () => {
      await result.current.start(3n);
    });
    expect(result.current.error).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect(result.current.status).toBeNull();
  });

  it('does not update state after unmount when a start resolves late (review)', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.endsWith('/start') ? new Promise<Response>((r) => (answer = r)) : Promise.resolve(respond(off)))));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useAgentDj(true, 10_000));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.start(3n);
    });
    unmount();
    answer(respond(on));
    await pending;
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

