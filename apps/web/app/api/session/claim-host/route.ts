/**
 * W21b: POST /api/session/claim-host  { sessionId }  (header x-blockbeat-host)  →
 *   { sessionId, amountWei, txHash }
 *
 * The host pulls its 20 % of the session's tips (W21a `claimHost`, any time, before or after
 * finalize), signed by HOST_PRIVATE_KEY with the fixed HOST_CLAIM_GAS_LIMIT. The contract pays
 * only the session host and only what is unclaimed; a revert (NothingToClaim, NotHost) is a
 * 409. Same presenter auth, body cap and error envelope as finalize (lib/host/http.ts).
 * Mock mode answers with no tx: the stage pulls the share from its in-browser simulator.
 */
import { NextResponse } from 'next/server';
import { authorize, errorResponse, readSessionId, tooLarge, withHostService } from '@/lib/host/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const denied = authorize(request) ?? tooLarge(request);
  if (denied) return denied;
  const sessionId = await readSessionId(request);
  if (sessionId === null) return errorResponse('INVALID_SESSION', 'body must be JSON { "sessionId": "<positive integer>" }', 400);
  return withHostService('session/claim-host', async (service) => {
    const result = await service.claimHost(sessionId);
    return NextResponse.json({ sessionId: result.sessionId.toString(), amountWei: result.amountWei.toString(), txHash: result.txHash });
  });
}
