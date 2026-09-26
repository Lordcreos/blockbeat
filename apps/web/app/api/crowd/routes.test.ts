import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrowdError, type CrowdManager, type CrowdStatus } from '@/lib/crowd/manager';
import { HOST_HEADER } from '@/lib/host/auth';

const idle: CrowdStatus = { running: false, stopping: false, sessionId: null, mode: null, players: null, minutes: null, pid: null, startedAt: null, lines: [], bar: null, bars: null, playersActive: null, playersTotal: null, notesSent: null, notesConfirmed: null, onStepPct: null, monSpent: null, lastExit: null };
const playing: CrowdStatus = { ...idle, running: true, sessionId: '3', mode: 'headless', players: 10, minutes: 3, pid: 5151, startedAt: 1, playersTotal: 10 };

const start = vi.fn<CrowdManager['start']>();
const stop = vi.fn<CrowdManager['stop']>();
const status = vi.fn<CrowdManager['status']>();
const stopForSession = vi.fn<CrowdManager['stopForSession']>();
vi.mock('@/lib/crowd/runtime', () => ({ getCrowdManager: (): CrowdManager => ({ start, stop, status, stopForSession }) }));

const startRoute = await import('./start/route');
const stopRoute = await import('./stop/route');
const statusRoute = await import('./status/route');

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000/api/crowd/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
const auth = { [HOST_HEADER]: 'top' };

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('/api/crowd/* (W19)', () => {
  beforeEach(() => {
    for (const f of [start, stop, status, stopForSession]) f.mockReset();
    vi.stubEnv('HOST_SECRET', 'top');
    vi.stubEnv('HOST_PRIVATE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_JOIN_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', '0x5FbDB2315678afecb367f032d93F642f64180aa3');
    vi.stubEnv('NEXT_PUBLIC_CROWD_ENABLED', '1');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('start is refused with 503 CROWD_DISABLED while NEXT_PUBLIC_CROWD_ENABLED is not 1', async () => {
    vi.stubEnv('NEXT_PUBLIC_CROWD_ENABLED', '');
    const res = await startRoute.POST(post('start', { sessionId: '3' }, auth));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('CROWD_DISABLED');
    expect(start).not.toHaveBeenCalled();
  });

  it('every route needs the host secret, and a missing server secret is 503', async () => {
    expect((await startRoute.POST(post('start', { sessionId: '3' }))).status).toBe(401);
    expect((await stopRoute.POST(post('stop', undefined, { [HOST_HEADER]: 'nope' }))).status).toBe(401);
    expect((await statusRoute.POST(post('status'))).status).toBe(401);
    vi.stubEnv('HOST_SECRET', '');
    expect((await startRoute.POST(post('start', { sessionId: '3' }, auth))).status).toBe(503);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('start runs 10 headless players for 3 minutes by default', async () => {
    start.mockReturnValueOnce(playing);
    const res = await startRoute.POST(post('start', { sessionId: '3' }, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(playing);
    expect(start).toHaveBeenCalledWith({ sessionId: 3n, players: 10, minutes: 3, mode: 'headless', baseUrl: null });
  });

  it('start takes players, minutes and the visible mode (5 windows by default, at most 6) with the join base URL', async () => {
    start.mockReturnValue(playing);
    await startRoute.POST(post('start', { sessionId: 4, players: 20, minutes: 2 }, auth));
    expect(start).toHaveBeenLastCalledWith({ sessionId: 4n, players: 20, minutes: 2, mode: 'headless', baseUrl: null });
    await startRoute.POST(post('start', { sessionId: '4', mode: 'visible' }, auth));
    expect(start).toHaveBeenLastCalledWith({ sessionId: 4n, players: 5, minutes: 3, mode: 'visible', baseUrl: 'http://localhost:3000' });
    vi.stubEnv('NEXT_PUBLIC_JOIN_BASE_URL', 'https://abc.trycloudflare.com/');
    await startRoute.POST(post('start', { sessionId: '4', mode: 'visible', players: 3, minutes: 1 }, auth));
    expect(start).toHaveBeenLastCalledWith({ sessionId: 4n, players: 3, minutes: 1, mode: 'visible', baseUrl: 'https://abc.trycloudflare.com' });
  });

  it('start validates the body and its size', async () => {
    const bad = ['{nope', {}, { sessionId: 0 }, { sessionId: 'abc' }, { sessionId: '3', players: 0 }, { sessionId: '3', players: 31 }, { sessionId: '3', players: 2.5 }, { sessionId: '3', minutes: 0 }, { sessionId: '3', minutes: 16 }, { sessionId: '3', minutes: 'x' }, { sessionId: '3', mode: 'ghost' }, { sessionId: '3', mode: 'visible', players: 7 }];
    for (const body of bad) expect((await startRoute.POST(post('start', body, auth))).status, JSON.stringify(body)).toBe(400);
    expect((await startRoute.POST(post('start', { sessionId: '3' }, { ...auth, 'content-length': '5000' }))).status).toBe(413);
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses a second start with 409 CROWD_RUNNING (single instance)', async () => {
    start.mockImplementationOnce(() => {
      throw new CrowdError('CROWD_RUNNING', 'a crowd is already playing session 3');
    });
    const res = await startRoute.POST(post('start', { sessionId: '3' }, auth));
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('CROWD_RUNNING');
  });

  it('answers 503 when the script is missing, and in mock mode (the crowd plays on a real chain)', async () => {
    start.mockImplementationOnce(() => {
      throw new CrowdError('CROWD_UNAVAILABLE', 'scripts/src/crowd.ts was not found next to the web app');
    });
    expect((await startRoute.POST(post('start', { sessionId: '3' }, auth))).status).toBe(503);
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '1');
    const mock = await startRoute.POST(post('start', { sessionId: '3' }, auth));
    expect(mock.status).toBe(503);
    expect(await code(mock)).toBe('CROWD_NEEDS_CHAIN');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('stop and status return the manager status; an unexpected error is a bare 500', async () => {
    stop.mockResolvedValueOnce({ ...playing, stopping: true });
    const s = await stopRoute.POST(post('stop', undefined, auth));
    expect(await s.json()).toMatchObject({ running: true, stopping: true });
    expect(stop).toHaveBeenCalledWith('host pressed Stop crowd');
    status.mockReturnValueOnce(idle);
    expect(await (await statusRoute.POST(post('status', undefined, auth))).json()).toEqual(idle);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    status.mockImplementationOnce(() => {
      throw new Error('internal detail');
    });
    const broken = await statusRoute.POST(post('status', undefined, auth));
    expect(broken.status).toBe(500);
    expect(JSON.stringify(await broken.json())).not.toContain('internal detail');
    spy.mockRestore();
  });
});
