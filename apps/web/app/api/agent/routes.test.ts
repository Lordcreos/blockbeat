import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError, type AgentManager, type AgentStatus } from '@/lib/agent/manager';
import { HOST_HEADER } from '@/lib/host/auth';

const idle: AgentStatus = { running: false, sessionId: null, pid: null, startedAt: null, lines: [], hitsSent: null, budgetLeft: null, brain: null, lastExit: null };
const playing: AgentStatus = { ...idle, running: true, sessionId: '3', pid: 4242, startedAt: 1, lines: ['bar 1 | sent 0 | budget 40 | brain rules'], budgetLeft: 40, brain: 'rules' };

const start = vi.fn<AgentManager['start']>();
const stop = vi.fn<AgentManager['stop']>();
const status = vi.fn<AgentManager['status']>();
const stopForSession = vi.fn<AgentManager['stopForSession']>();
vi.mock('@/lib/agent/runtime', () => ({ getAgentManager: (): AgentManager => ({ start, stop, status, stopForSession }) }));

const startRoute = await import('./start/route');
const stopRoute = await import('./stop/route');
const statusRoute = await import('./status/route');

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/agent/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
const auth = { [HOST_HEADER]: 'top' };

describe('/api/agent/* (W12)', () => {
  beforeEach(() => {
    for (const f of [start, stop, status, stopForSession]) f.mockReset();
    vi.stubEnv('HOST_SECRET', 'top');
    vi.stubEnv('HOST_PRIVATE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_ADDRESS', '0x5FbDB2315678afecb367f032d93F642f64180aa3');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('every route needs the host secret, like the session routes', async () => {
    expect((await startRoute.POST(post('start', { sessionId: '3' }))).status).toBe(401);
    expect((await stopRoute.POST(post('stop', undefined, { [HOST_HEADER]: 'nope' }))).status).toBe(401);
    expect((await statusRoute.POST(post('status'))).status).toBe(401);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('start spawns the agent for the requested session and returns its status', async () => {
    start.mockReturnValueOnce(playing);
    const res = await startRoute.POST(post('start', { sessionId: '3' }, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(playing);
    expect(start).toHaveBeenCalledWith(3n);
  });

  it('start validates the session id and the body size', async () => {
    for (const body of ['{nope', {}, { sessionId: 0 }, { sessionId: 'abc' }]) {
      expect((await startRoute.POST(post('start', body, auth))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await startRoute.POST(post('start', { sessionId: '3' }, { ...auth, 'content-length': '5000' }))).status).toBe(413);
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses to start twice with 409', async () => {
    start.mockImplementationOnce(() => {
      throw new AgentError('AGENT_RUNNING', 'the DJ is already playing session 3');
    });
    const res = await startRoute.POST(post('start', { sessionId: '3' }, auth));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AGENT_RUNNING');
  });

  it('answers 503 when the agent is not available and in mock mode (no chain to play on)', async () => {
    start.mockImplementationOnce(() => {
      throw new AgentError('AGENT_UNAVAILABLE', 'apps/agent was not found next to the web app');
    });
    expect((await startRoute.POST(post('start', { sessionId: '3' }, auth))).status).toBe(503);
    vi.stubEnv('NEXT_PUBLIC_BLOCKBEAT_MOCK', '1');
    const mock = await startRoute.POST(post('start', { sessionId: '3' }, auth));
    expect(mock.status).toBe(503);
    expect(((await mock.json()) as { error: { code: string } }).error.code).toBe('AGENT_NEEDS_CHAIN');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('stop kills the agent and returns the final status', async () => {
    stop.mockResolvedValueOnce({ ...idle, lastExit: 'stopped: host pressed Stop DJ (exited with code 0)' });
    const res = await stopRoute.POST(post('stop', undefined, auth));
    expect(res.status).toBe(200);
    expect(((await res.json()) as AgentStatus).lastExit).toMatch(/Stop DJ/);
    expect(stop).toHaveBeenCalledWith('host pressed Stop DJ');
  });

  it('status returns the live status', async () => {
    status.mockReturnValueOnce(playing);
    const res = await statusRoute.POST(post('status', undefined, auth));
    expect(await res.json()).toEqual(playing);
  });

  it('never leaks internals on an unexpected error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    start.mockImplementationOnce(() => {
      throw new TypeError('secret internal detail');
    });
    const res = await startRoute.POST(post('start', { sessionId: '3' }, auth));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret internal detail');
    error.mockRestore();
  });
});
