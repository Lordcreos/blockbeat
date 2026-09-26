/**
 * W21b: off-chain notes for tips.
 *
 * POST /api/tip-note  { sessionId, txHash, name?, message? }  →  201 { note }
 *   After a tip confirms, the phone posts its optional name (24) and message (140). The server
 *   reads the receipt and keeps the note only when it holds a `Tipped` log of the Blockbeat
 *   contract for that session; the tipper and the amount come from the log. One note per tx.
 *   Plain text only (lib/tips/note.ts). 404 RECEIPT_NOT_FOUND with Retry-After while the node
 *   has not indexed the receipt; 409 on a second note; 429 per IP. Mock mode has no receipts:
 *   the body's `mock: { from, amountWei }` (the simulator tip) is taken instead.
 *
 * GET /api/tip-note?session=N&limit=M  →  { notes } newest first (limit 1..500, default 50).
 *
 * Errors are { error: { code, message } } and never carry RPC or file-system detail.
 */
import { NextResponse } from 'next/server';
import { isMockMode } from '@/lib/chain/clients';
import { clientIp } from '@/lib/clientIp';
import { parseTipNoteBody } from '@/lib/tips/note';
import { TipNoteError } from '@/lib/tips/noteService';
import { RateLimitedError } from '@/lib/tips/rateLimit';
import { getTipNoteReadLimiter, getTipNoteService } from '@/lib/tips/runtime';
import { parseSessionId } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A full note (140 characters of 4-byte emoji) plus the fields stays well under this. */
const MAX_BODY_BYTES = 2048;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function errorResponse(code: string, message: string, status: number, retryAfterMs: number | null = null): NextResponse {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (retryAfterMs !== null) headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export async function POST(request: Request): Promise<NextResponse> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return errorResponse('PAYLOAD_TOO_LARGE', `body must be under ${MAX_BODY_BYTES} bytes`, 413);
  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return errorResponse('PAYLOAD_TOO_LARGE', `body must be under ${MAX_BODY_BYTES} bytes`, 413);
    body = JSON.parse(text);
  } catch {
    return errorResponse('INVALID_JSON', 'body must be JSON: { "sessionId", "txHash", "name"?, "message"? }', 400);
  }
  const parsed = parseTipNoteBody(body, { allowMock: isMockMode() });
  if (!parsed.ok) return errorResponse(parsed.code, parsed.message, 400);

  try {
    const note = await getTipNoteService().submit(parsed.value, clientIp(request));
    return NextResponse.json({ note }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof TipNoteError) return errorResponse(error.code, error.message, error.status, error.retryAfterMs);
    console.error('tip-note: unexpected error', error);
    return errorResponse('INTERNAL_ERROR', 'unexpected error', 500);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const sessionId = parseSessionId(url.searchParams.get('session') ?? undefined);
  if (sessionId === null) return errorResponse('INVALID_SESSION', 'session must be a positive integer', 400);
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && !/^\d{1,6}$/.test(rawLimit)) return errorResponse('INVALID_LIMIT', `limit must be an integer from 1 to ${MAX_LIMIT}`, 400);
  const limit = rawLimit === null ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(1, Number(rawLimit)));
  try {
    getTipNoteReadLimiter().take(clientIp(request));
    const notes = await getTipNoteService().list(sessionId, limit);
    return NextResponse.json({ notes }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof RateLimitedError) return errorResponse('RATE_LIMITED', error.message, 429, error.retryAfterMs);
    console.error('tip-note: list failed', error);
    return errorResponse('INTERNAL_ERROR', 'unexpected error', 500);
  }
}
