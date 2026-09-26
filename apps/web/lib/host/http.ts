/**
 * Shared pieces of the two session routes: presenter auth, error envelope, service errors.
 * Both routes hold the host key indirectly (through lib/host/runtime), so they refuse
 * every call that does not carry HOST_SECRET. Only in mock mode with neither a secret nor
 * a host key configured are they open: there is nothing to protect and no chain to spend on.
 * Wrong secrets are rate-limited per IP so a short secret cannot be brute-forced.
 */
import { NextResponse } from 'next/server';
import { parseSessionId } from '../types';
import { isMockMode } from '../chain/clients';
import { clientIp } from '../clientIp';
import { hostSecretFromEnv, isAuthorizedHost } from './auth';
import { HostNotConfiguredError, getHostService } from './runtime';
import { HostError, type HostErrorCode, type HostService } from './service';

const STATUS: Record<HostErrorCode, number> = { SEND_FAILED: 502, TX_REVERTED: 409, LOG_MISSING: 502, TIMEOUT: 504 };

/** Largest request body either route accepts (`{ "sessionId": "<uint256>" }` is under 100 bytes). */
export const MAX_BODY_BYTES = 1024;
/** Review L1: 30 typos a minute before a lockout; the presenter must never lock the stage out. */
export const MAX_AUTH_FAILURES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

export function errorResponse(code: string, message: string, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export { clientIp };

const authFailures = new Map<string, number[]>();

function recentFailures(ip: string, now: number): number[] {
  const stamps = (authFailures.get(ip) ?? []).filter((t) => t > now - WINDOW_MS);
  if (stamps.length === 0) authFailures.delete(ip);
  else authFailures.set(ip, stamps);
  return stamps;
}

/** null when the caller may proceed; otherwise the response to send. */
export function authorize(request: Request): NextResponse | null {
  const secret = hostSecretFromEnv(process.env);
  if (secret === null) {
    const keyConfigured = Boolean(process.env.HOST_PRIVATE_KEY?.trim());
    if (isMockMode() && !keyConfigured) return null;
    return errorResponse('HOST_NOT_CONFIGURED', 'HOST_SECRET is not configured on the server', 503);
  }
  const ip = clientIp(request);
  const now = Date.now();
  const failures = recentFailures(ip, now);
  if (failures.length >= MAX_AUTH_FAILURES_PER_MINUTE) {
    const retryAfter = Math.ceil(((failures[0] ?? now) + WINDOW_MS - now) / 1000);
    return errorResponse('RATE_LIMITED', 'too many failed attempts; try again later', 429, { 'retry-after': String(Math.max(1, retryAfter)) });
  }
  if (!isAuthorizedHost(request.headers, secret)) {
    authFailures.set(ip, [...failures, now]);
    return errorResponse('UNAUTHORIZED', 'missing or wrong host secret', 401);
  }
  return null;
}

/** Rejects a body whose declared size exceeds the cap before anything is buffered. */
export function tooLarge(request: Request): NextResponse | null {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return errorResponse('PAYLOAD_TOO_LARGE', `body must be under ${MAX_BODY_BYTES} bytes`, 413);
  }
  return null;
}

/** Runs `fn` with the host service, translating typed failures; never leaks internals on 500. */
export async function withHostService(what: string, fn: (service: HostService) => Promise<NextResponse>): Promise<NextResponse> {
  let service: HostService;
  try {
    service = getHostService();
  } catch (error) {
    if (error instanceof HostNotConfiguredError) return errorResponse('HOST_NOT_CONFIGURED', error.message, 503);
    console.error(`${what}: host service init failed`, error);
    return errorResponse('INTERNAL_ERROR', 'unexpected error', 500);
  }
  try {
    return await fn(service);
  } catch (error) {
    if (error instanceof HostError) return errorResponse(error.code, error.message, STATUS[error.code]);
    console.error(`${what}: unexpected error`, error);
    return errorResponse('INTERNAL_ERROR', 'unexpected error', 500);
  }
}

/** `{ "sessionId": <positive integer or decimal string> }` from the body, or null when malformed. */
export async function readSessionId(request: Request): Promise<bigint | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null; // reported as INVALID_SESSION by the caller
  }
  const raw = typeof body === 'object' && body !== null ? (body as { sessionId?: unknown }).sessionId : undefined;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? BigInt(raw) : null;
  if (typeof raw === 'string' && raw.length <= 78) return parseSessionId(raw);
  return null;
}
