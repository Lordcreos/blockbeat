/**
 * W19: request parsing and error mapping for the /api/crowd routes. Typed manager errors keep
 * their code; anything else is a 500 with no internals.
 */
import { NextResponse } from 'next/server';
import { parseSessionId } from '../types';
import { MAX_BODY_BYTES, errorResponse } from '../host/http';
import { CrowdError, type CrowdErrorCode, type CrowdMode } from './manager';

const STATUS: Record<CrowdErrorCode, number> = { CROWD_RUNNING: 409, CROWD_UNAVAILABLE: 503, SPAWN_FAILED: 502, CROWD_MISCONFIGURED: 503 };

export const MAX_CROWD_PLAYERS = 30;
/** Headed browser windows on the laptop: more than 6 do not fit the screen. */
export const MAX_VISIBLE_PLAYERS = 6;
export const MAX_CROWD_MINUTES = 15;
export const DEFAULT_CROWD = { headless: { players: 10 }, visible: { players: 5 }, minutes: 3 } as const;

export interface CrowdStartBody {
  sessionId: bigint;
  players: number;
  minutes: number;
  mode: CrowdMode;
}

/** `{ sessionId, players?, minutes?, mode? }`, or a message saying what is wrong. */
export async function readCrowdStart(request: Request): Promise<CrowdStartBody | string> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return `body must be under ${MAX_BODY_BYTES} bytes`;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return 'body must be JSON { "sessionId": "<positive integer>", "players"?: n, "minutes"?: n, "mode"?: "headless" | "visible" }';
  }
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  const rawId = b.sessionId;
  const sessionId = typeof rawId === 'number' ? (Number.isSafeInteger(rawId) && rawId > 0 ? BigInt(rawId) : null) : typeof rawId === 'string' && rawId.length <= 78 ? parseSessionId(rawId) : null;
  if (sessionId === null) return 'sessionId must be a positive integer';
  const mode = b.mode ?? 'headless';
  if (mode !== 'headless' && mode !== 'visible') return 'mode must be "headless" or "visible"';
  const maxPlayers = mode === 'visible' ? MAX_VISIBLE_PLAYERS : MAX_CROWD_PLAYERS;
  const players = b.players ?? DEFAULT_CROWD[mode].players;
  if (typeof players !== 'number' || !Number.isInteger(players) || players < 1 || players > maxPlayers) return `players must be an integer in 1..${maxPlayers}`;
  const minutes = b.minutes ?? DEFAULT_CROWD.minutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_CROWD_MINUTES) return `minutes must be a number above 0 and at most ${MAX_CROWD_MINUTES}`;
  return { sessionId, players, minutes, mode };
}

/** The phones' base URL for visible mode: the public join URL when set, else this server. */
export function joinBaseFor(request: Request, env: Record<string, string | undefined> = process.env): string {
  const configured = env.NEXT_PUBLIC_JOIN_BASE_URL?.trim().replace(/\/+$/, '');
  return configured ? configured : new URL(request.url).origin;
}

export function crowdFailure(what: string, error: unknown): NextResponse {
  if (error instanceof CrowdError) return errorResponse(error.code, error.message, STATUS[error.code]);
  console.error(`${what}: unexpected error`, error);
  return errorResponse('INTERNAL_ERROR', 'unexpected error', 500);
}
