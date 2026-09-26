/**
 * POST /api/crowd/start  { sessionId, players?, minutes?, mode? }  (header x-blockbeat-host)  →  CrowdStatus
 *
 * W19: starts the crowd simulator (scripts/src/crowd.ts) as a child of this server: `players`
 * simulated players (default 10, at most 30) for `minutes` (default 3) in the session, funded
 * from the drip key and swept back when they stop. `mode: "visible"` opens headed phone
 * windows on this laptop instead (default 5, at most 6). 409 when a crowd already runs or is
 * still sweeping, 503 when scripts/ is missing or the app runs the in-memory simulator.
 */
import { NextResponse } from 'next/server';
import { isMockMode } from '@/lib/chain/clients';
import { crowdEnabled } from '@/lib/crowd/flag';
import { crowdFailure, joinBaseFor, readCrowdStart } from '@/lib/crowd/http';
import { getCrowdManager } from '@/lib/crowd/runtime';
import { authorize, errorResponse, tooLarge } from '@/lib/host/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const denied = authorize(request) ?? tooLarge(request);
  if (denied) return denied;
  if (!crowdEnabled()) return errorResponse('CROWD_DISABLED', 'the crowd simulator is off: set NEXT_PUBLIC_CROWD_ENABLED=1 and restart the server', 503);
  const body = await readCrowdStart(request);
  if (typeof body === 'string') return errorResponse('INVALID_REQUEST', body, 400);
  if (isMockMode()) return errorResponse('CROWD_NEEDS_CHAIN', 'the simulated players play on a real chain; this app runs the in-memory simulator', 503);
  try {
    return NextResponse.json(getCrowdManager().start({ ...body, baseUrl: body.mode === 'visible' ? joinBaseFor(request) : null }));
  } catch (error) {
    return crowdFailure('crowd/start', error);
  }
}
