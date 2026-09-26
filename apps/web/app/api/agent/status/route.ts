/**
 * POST /api/agent/status  (header x-blockbeat-host)  →  AgentStatus
 *
 * W12: on/off, session, last three output lines, hits sent, budget left, brain. Polled by the
 * stage's DJ panel; POST so the host secret travels in the header like the other host routes.
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
    return NextResponse.json(getAgentManager().status());
  } catch (error) {
    return agentFailure('agent/status', error);
  }
}
