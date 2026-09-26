/**
 * POST /api/session/finalize  { sessionId }  (header x-blockbeat-host)  →
 *   { sessionId, tokenId, contributors, txHash }
 *
 * Sends `finalize(sessionId)` from HOST_PRIVATE_KEY (the contract enforces host-only) and
 * returns the token from the Finalized log. 409 when the chain reverts (already finalized,
 * wrong host), 400 on a bad id.
 *
 * Review H4 / W12: a resident DJ started from the stage for this session is stopped first
 * (SIGTERM, not awaited), so it sends no more hits into a finalized session. W19: so is a
 * simulated crowd playing it (it also stops by itself on the Finalized event, then sweeps).
 */
import { NextResponse } from 'next/server';
import { getAgentManager } from '@/lib/agent/runtime';
import { getCrowdManager } from '@/lib/crowd/runtime';
import { authorize, errorResponse, readSessionId, tooLarge, withHostService } from '@/lib/host/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const denied = authorize(request) ?? tooLarge(request);
  if (denied) return denied;
  const sessionId = await readSessionId(request);
  if (sessionId === null) return errorResponse('INVALID_SESSION', 'body must be JSON { "sessionId": "<positive integer>" }', 400);
  return withHostService('session/finalize', async (service) => {
    void getAgentManager().stopForSession(sessionId, 'session finalized');
    void getCrowdManager().stopForSession(sessionId, 'session finalized');
    const result = await service.finalize(sessionId);
    return NextResponse.json({
      sessionId: result.sessionId.toString(),
      tokenId: result.tokenId.toString(),
      contributors: result.contributors.toString(),
      txHash: result.txHash,
    });
  });
}
