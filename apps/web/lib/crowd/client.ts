'use client';
/**
 * W19: browser side of the crowd routes, for the host bar. The secret travels only as the
 * host header, like the session and DJ routes; every status body is checked field by field.
 */
import { HOST_HEADER } from '../host/auth';
import { HostClientError } from '../host/client';
import type { CrowdMode, CrowdStatus } from './manager';

export type { CrowdMode, CrowdStatus };

async function post(path: string, secret: string | null, body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (secret) headers[HOST_HEADER] = secret;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method: 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let json: unknown;
  try {
    json = await res.json();
  } catch (error) {
    throw new HostClientError('BAD_RESPONSE', `${path} returned ${res.status} with a non-JSON body (${error instanceof Error ? error.message : String(error)})`, res.status);
  }
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  if (!res.ok) {
    const err = typeof record.error === 'object' && record.error !== null ? (record.error as { code?: unknown; message?: unknown }) : {};
    throw new HostClientError(typeof err.code === 'string' ? err.code : `HTTP_${res.status}`, typeof err.message === 'string' ? err.message : `${path} failed with ${res.status}`, res.status);
  }
  return record;
}

const isNum = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const isStr = (v: unknown): v is string | null => v === null || typeof v === 'string';

function statusOf(body: Record<string, unknown>, path: string): CrowdStatus {
  const b = body;
  const numbers = ['players', 'minutes', 'pid', 'startedAt', 'bar', 'bars', 'playersActive', 'playersTotal', 'notesSent', 'notesConfirmed', 'onStepPct', 'monSpent'] as const;
  const mode = b.mode;
  const ok =
    typeof b.running === 'boolean' &&
    typeof b.stopping === 'boolean' &&
    isStr(b.sessionId) &&
    isStr(b.lastExit) &&
    (mode === null || mode === 'headless' || mode === 'visible') &&
    Array.isArray(b.lines) &&
    b.lines.every((l): l is string => typeof l === 'string') &&
    numbers.every((k) => isNum(b[k]));
  if (!ok) throw new HostClientError('BAD_RESPONSE', `${path} returned an unexpected body`, 200);
  return body as unknown as CrowdStatus;
}

export async function crowdStartRequest(secret: string | null, request: { sessionId: bigint; players?: number; minutes?: number; mode: CrowdMode }): Promise<CrowdStatus> {
  const { sessionId, ...rest } = request;
  return statusOf(await post('/api/crowd/start', secret, { sessionId: sessionId.toString(), ...rest }), 'crowd/start');
}

export async function crowdStopRequest(secret: string | null): Promise<CrowdStatus> {
  return statusOf(await post('/api/crowd/stop', secret), 'crowd/stop');
}

export async function crowdStatusRequest(secret: string | null): Promise<CrowdStatus> {
  return statusOf(await post('/api/crowd/status', secret), 'crowd/status');
}
