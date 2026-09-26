/**
 * POST /api/agent/stop  (header x-blockbeat-host)  →  AgentStatus
 *
 * W12: stops the DJ started from the stage (SIGTERM to its process group, SIGKILL after the
 * grace period) and answers once it exited. A no-op when none runs.
 */
import { NextResponse } from 'next/server';
import { getAgentManager } from '@/lib/agent/runtime';
import { authorize } from '@/lib/host/http';
import { agentFailure } from '@/lib/agent/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await getAgentManager().stop('host pressed Stop DJ'));
  } catch (error) {
    return agentFailure('agent/stop', error);
  }
}
