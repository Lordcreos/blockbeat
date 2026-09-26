import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { HOST_HEADER } from './auth';
import { HOST_SECRET_STORAGE_KEY, HostClientError, claimHostRequest, clearHostSecret, finalizeSessionRequest, loadHostSecret, saveHostSecret, startSessionRequest } from './client';

const TX = `0x${'ef'.repeat(32)}` as Hash;

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: () => null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('host secret storage', () => {
  it('round-trips through storage and clears', () => {
    const storage = memoryStorage();
    expect(loadHostSecret(storage)).toBeNull();
    saveHostSecret('  abc ', storage);
    expect(storage.getItem(HOST_SECRET_STORAGE_KEY)).toBe('abc');
    expect(loadHostSecret(storage)).toBe('abc');
    saveHostSecret('', storage);
    expect(loadHostSecret(storage)).toBeNull();
    saveHostSecret('x', storage);
    clearHostSecret(storage);
    expect(loadHostSecret(storage)).toBeNull();
  });

  it('reports (never swallows) a storage failure', () => {
    const warn = vi.fn();
    const broken = { ...memoryStorage(), getItem: () => { throw new Error('quota'); }, setItem: () => { throw new Error('quota'); } } as Storage;
    expect(loadHostSecret(broken, warn)).toBeNull();
    saveHostSecret('x', broken, warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('session requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs /api/session/start with the secret header and parses the id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: '42', txHash: TX }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await startSessionRequest('top')).toEqual({ sessionId: 42n, txHash: TX });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/session/start');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get(HOST_HEADER)).toBe('top');
  });

  it('omits the header when there is no secret (mock mode)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: '1', txHash: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await startSessionRequest(null);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has(HOST_HEADER)).toBe(false);
  });

  it('POSTs /api/session/finalize with the session id and parses the result', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: '7', tokenId: '3', contributors: '12', txHash: TX }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await finalizeSessionRequest('top', 7n)).toEqual({ sessionId: 7n, tokenId: 3n, contributors: 12n, txHash: TX });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/session/finalize');
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: '7' });
  });

  it('W21b: POSTs /api/session/claim-host and parses the amount; a malformed answer is BAD_RESPONSE', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: '7', amountWei: '4000', txHash: TX }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await claimHostRequest('top', 7n)).toEqual({ sessionId: 7n, amountWei: 4000n, txHash: TX });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/session/claim-host');
    expect(new Headers(init.headers).get(HOST_HEADER)).toBe('top');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessionId: '7', amountWei: 'lots', txHash: null }), { status: 200 })));
    await expect(claimHostRequest('top', 7n)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('throws a HostClientError carrying the API code and message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'nope' } }), { status: 401 })));
    const err = await startSessionRequest('bad').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostClientError);
    expect((err as HostClientError).code).toBe('UNAUTHORIZED');
    expect((err as HostClientError).status).toBe(401);
    expect((err as HostClientError).message).toBe('nope');
  });

  it('rejects a malformed success body instead of returning garbage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessionId: 'abc' }), { status: 200 })));
    await expect(startSessionRequest('top')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});

describe('agent requests (W12)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const playing = { running: true, sessionId: '3', pid: 4242, startedAt: 1, lines: ['bar 1 | sent 2 | budget 38 | brain openai'], hitsSent: 2, budgetLeft: 38, brain: 'openai', lastExit: null };

  it('starts the DJ for a session with the host header and parses the status', async () => {
    const { agentStartRequest } = await import('./client');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(playing), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const status = await agentStartRequest('top', 3n);
    expect(status).toEqual(playing);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/agent/start');
    expect((init.headers as Record<string, string>)[HOST_HEADER]).toBe('top');
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: '3' });
  });

  it('stops and polls the DJ', async () => {
    const { agentStatusRequest, agentStopRequest } = await import('./client');
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('stop') ? { ...playing, running: false, sessionId: null, pid: null, lastExit: 'stopped' } : playing), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await agentStopRequest('top')).running).toBe(false);
    expect((await agentStatusRequest('top')).hitsSent).toBe(2);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/agent/stop', '/api/agent/status']);
  });

  it('rejects a malformed status body and surfaces the server code', async () => {
    const { agentStatusRequest, agentStartRequest } = await import('./client');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ running: 'yes' }), { status: 200 })));
    await expect(agentStatusRequest('top')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'AGENT_RUNNING', message: 'already playing' } }), { status: 409 })));
    await expect(agentStartRequest('top', 3n)).rejects.toMatchObject({ code: 'AGENT_RUNNING', status: 409 });
  });
});
