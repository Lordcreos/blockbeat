/**
 * POST /api/crowd/status  (header x-blockbeat-host)  →  CrowdStatus
 *
 * W19: running / stopping, session, mode, players active, notes sent and confirmed, on-step
 * ratio, MON spent and the last three output lines. Polled by the host bar's crowd panel; POST
 * so the host secret travels in the header like the other host routes.
 */
import { NextResponse } from 'next/server';
import { crowdFailure } from '@/lib/crowd/http';
import { getCrowdManager } from '@/lib/crowd/runtime';
import { authorize } from '@/lib/host/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    return NextResponse.json(getCrowdManager().status());
  } catch (error) {
    return crowdFailure('crowd/status', error);
  }
}
