/**
 * POST /api/drip  { address, topUp? }  →  { txHash, track, alreadyFunded, topUp?, topUpsLeft? }
 *
 * Funds a burner wallet once with DRIP_AMOUNT_MON. Validation with viem isAddress, one
 * drip per address ever, rate-limited per IP and globally (in memory, env-driven caps; a
 * failed send burns no slot and a 429 carries Retry-After). In mock mode txHash is
 * null. Errors use { error: { code, message } } and never expose RPC or key details.
 *
 * W12: `{ address, topUp: true }` asks for another DRIP_AMOUNT_MON for a wallet this server
 * funded before, while it holds under 0.03 MON, at most twice (409 otherwise), through the
 * same caps and pacing as the first drip.
 *
 * W21b: `{ address, mode: "tipper" }` funds the tip page's burner once with the small tipper
 * amount, counted apart from the player caps (lib/drip/tipper.ts): { txHash, alreadyFunded, amountWei }.
 * W19: `sessionId` (optional, the session the phone joins) feeds the per-session room cap
 * (DRIP_MAX_PLAYERS_PER_SESSION); over it the answer is 409 ROOM_FULL.
 */
import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/clientIp';
import { parseSessionId } from '@/lib/types';
import { DripError } from '@/lib/drip/service';
import { getDripService, getTipperDripService } from '@/lib/drip/runtime';
import { TipperDripError } from '@/lib/drip/tipper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Largest body we will parse: `{ "address": "0x" + 40 hex }` is ~60 bytes. */
const MAX_BODY_BYTES = 1024;
const MAX_ADDRESS_LENGTH = 42;

function errorResponse(code: string, message: string, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export async function POST(request: Request): Promise<NextResponse> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) {
    return errorResponse('PAYLOAD_TOO_LARGE', `body must be under ${MAX_BODY_BYTES} bytes`, 413);
  }
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return errorResponse('PAYLOAD_TOO_LARGE', `body must be under ${MAX_BODY_BYTES} bytes`, 413);
    }
    body = JSON.parse(text);
  } catch {
    return errorResponse('INVALID_JSON', 'body must be JSON: { "address": "0x…" }', 400);
  }
  const fields = typeof body === 'object' && body !== null ? (body as { address?: unknown; topUp?: unknown; mode?: unknown; sessionId?: unknown }) : {};
  const { address, topUp, mode, sessionId: rawSession } = fields;
  if (typeof address !== 'string' || address.length > MAX_ADDRESS_LENGTH) {
    return errorResponse('INVALID_ADDRESS', 'address must be a 0x-prefixed 20-byte hex string', 400);
  }
  if (topUp !== undefined && typeof topUp !== 'boolean') {
    return errorResponse('INVALID_TOPUP', 'topUp must be true or false', 400);
  }
  if (mode !== undefined && mode !== 'tipper') return errorResponse('INVALID_MODE', 'mode must be "tipper" or absent', 400);
  if (mode === 'tipper') {
    if (topUp === true) return errorResponse('INVALID_TOPUP', 'tipper wallets get no top-ups', 400);
    const raw = fields.sessionId;
    const sessionId = typeof raw === 'string' && raw.length <= 78 ? parseSessionId(raw) : typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? BigInt(raw) : null;
    if (sessionId === null) return errorResponse('INVALID_SESSION', 'tipper mode needs the sessionId being tipped', 400);
    return tipperDrip(address, sessionId, request);
  }
  let sessionId: bigint | null = null;
  if (rawSession !== undefined) {
    if (typeof rawSession === 'number') sessionId = Number.isSafeInteger(rawSession) && rawSession > 0 ? BigInt(rawSession) : null;
    else if (typeof rawSession === 'string' && rawSession.length <= 78) sessionId = parseSessionId(rawSession);
    if (sessionId === null) return errorResponse('INVALID_SESSION', 'sessionId must be a positive integer', 400);
  }
  const session = sessionId === null ? {} : { sessionId: sessionId.toString() };

  try {
    const ip = clientIp(request);
    const result = await getDripService().drip(topUp === true ? { address, ip, topUp: true, ...session } : { address, ip, ...session });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DripError) {
      const headers: Record<string, string> = {};
      if (error.retryAfterMs !== null) headers['retry-after'] = String(Math.ceil(error.retryAfterMs / 1000));
      return errorResponse(error.code, error.message, error.status, headers);
    }
    console.error('drip: unexpected error', error);
    return errorResponse('INTERNAL_ERROR', 'unexpected error', 500);
  }
}

/** W21b: the tip page's one-off funding. */
async function tipperDrip(address: string, sessionId: bigint, request: Request): Promise<NextResponse> {
  try {
    return NextResponse.json(await getTipperDripService().drip({ address, ip: clientIp(request), sessionId }));
  } catch (error) {
    if (error instanceof TipperDripError) {
      return errorResponse(error.code, error.message, error.status, error.retryAfterMs === null ? {} : { 'retry-after': String(Math.ceil(error.retryAfterMs / 1000)) });
    }
    console.error('drip: unexpected tipper error', error);
    return errorResponse('INTERNAL_ERROR', 'unexpected error', 500);
  }
}
