/**
 * POST /api/agent/start  { sessionId }  (header x-blockbeat-host)  →  AgentStatus
 *
 * W12: starts the resident DJ (`pnpm --filter agent start`) as a child of this server for the
 * session, unbounded bars, with its own apps/agent/.env. 409 when one already runs, 503 when
 * apps/agent is missing or the app runs the in-memory simulator (no chain for the agent).
 */
import { NextResponse } from 'next/server';
import { getAgentManager } from '@/lib/agent/runtime';
import { isMockMode } from '@/lib/chain/clients';
import { authorize, errorResponse, readSessionId, tooLarge } from '@/lib/host/http';
import { agentFailure } from '@/lib/agent/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const denied = authorize(request) ?? tooLarge(request);
  if (denied) return denied;
  const sessionId = await readSessionId(request);
  if (sessionId === null) return errorResponse('INVALID_SESSION', 'body must be JSON { "sessionId": "<positive integer>" }', 400);
  if (isMockMode()) return errorResponse('AGENT_NEEDS_CHAIN', 'the DJ agent plays on a real chain; this app runs the in-memory simulator', 503);
  try {
    return NextResponse.json(getAgentManager().start(sessionId));
  } catch (error) {
    return agentFailure('agent/start', error);
  }
}
