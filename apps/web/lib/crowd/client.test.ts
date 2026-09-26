import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostClientError } from '../host/client';
import { HOST_HEADER } from '../host/auth';
import type { CrowdStatus } from './manager';
import { crowdStartRequest, crowdStatusRequest, crowdStopRequest } from './client';

const idle: CrowdStatus = { running: false, stopping: false, sessionId: null, mode: null, players: null, minutes: null, pid: null, startedAt: null, lines: [], bar: null, bars: null, playersActive: null, playersTotal: null, notesSent: null, notesConfirmed: null, onStepPct: null, monSpent: null, lastExit: null };

function respond(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('crowd client (W19)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the start body with the host secret in the header', async () => {
    const fetchSpy = respond(200, { ...idle, running: true, sessionId: '3', mode: 'headless', players: 10, minutes: 3 });
    const status = await crowdStartRequest('top', { sessionId: 3n, players: 10, mode: 'headless' });
    expect(status.running).toBe(true);
    const [path, init] = fetchSpy.mock.calls[0] ?? [];
    expect(path).toBe('/api/crowd/start');
    expect((init?.headers as Record<string, string>)[HOST_HEADER]).toBe('top');
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: '3', players: 10, mode: 'headless' });
  });

  it('turns an error envelope into a HostClientError with its code and status', async () => {
    respond(409, { error: { code: 'CROWD_RUNNING', message: 'a crowd is already playing session 3' } });
    await expect(crowdStopRequest('top')).rejects.toMatchObject({ code: 'CROWD_RUNNING', status: 409 });
    await expect(crowdStopRequest('top')).rejects.toBeInstanceOf(HostClientError);
  });

  it('refuses a status body that does not have the expected shape', async () => {
    respond(200, { ...idle, notesSent: 'lots' });
    await expect(crowdStatusRequest('top')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    respond(200, { ...idle, mode: 'ghost' });
    await expect(crowdStatusRequest('top')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    respond(200, idle);
    await expect(crowdStatusRequest('top')).resolves.toEqual(idle);
  });
});
