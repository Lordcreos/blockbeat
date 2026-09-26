/**
 * POST /api/session/start  (header x-blockbeat-host: HOST_SECRET)  →  { sessionId, txHash }
 *
 * Sends `startSession()` from HOST_PRIVATE_KEY and returns the id parsed from the
 * SessionStarted log. 401 without the secret, 503 when the server is not configured.
 */
import { NextResponse } from 'next/server';
import { authorize, withHostService } from '@/lib/host/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const denied = authorize(request);
  if (denied) return denied;
  return withHostService('session/start', async (service) => {
    const result = await service.startSession();
    return NextResponse.json({ sessionId: result.sessionId.toString(), txHash: result.txHash });
  });
}
