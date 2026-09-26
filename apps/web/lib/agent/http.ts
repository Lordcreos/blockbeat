/**
 * Shared error mapping for the /api/agent routes (W12): typed manager errors keep their code,
 * anything else is a 500 with no internals.
 */
import { NextResponse } from 'next/server';
import { errorResponse } from '../host/http';
import { AgentError, type AgentErrorCode } from './manager';

const STATUS: Record<AgentErrorCode, number> = { AGENT_RUNNING: 409, AGENT_UNAVAILABLE: 503, SPAWN_FAILED: 502 };

export function agentFailure(what: string, error: unknown): NextResponse {
  if (error instanceof AgentError) return errorResponse(error.code, error.message, STATUS[error.code]);
  console.error(`${what}: unexpected error`, error);
  return errorResponse('INTERNAL_ERROR', 'unexpected error', 500);
}
