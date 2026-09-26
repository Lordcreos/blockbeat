/**
 * POST /api/crowd/stop  (header x-blockbeat-host)  →  CrowdStatus
 *
 * W19: stops the simulated players (SIGTERM to the crowd's process group). Answers at once
 * with `stopping: true` while the crowd sweeps its burners back to the drip wallet; SIGKILL
 * follows only if it has not exited after the grace period. A no-op when none runs.
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
    return NextResponse.json(await getCrowdManager().stop('host pressed Stop crowd'));
  } catch (error) {
    return crowdFailure('crowd/stop', error);
  }
}
