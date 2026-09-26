'use client';
/**
 * Browser side of the host flow: the presenter's secret (kept in sessionStorage, so it dies
 * with the tab and never persists on disk) and the two calls to the session routes. The
 * secret never leaves the device except as the request header the routes expect.
 */
import { useSyncExternalStore } from 'react';
import type { Hash } from 'viem';
import type { AgentStatus } from '../agent/manager';
import { HOST_HEADER } from './auth';

export const HOST_SECRET_STORAGE_KEY = 'blockbeat:host:secret:v1';

type Warn = (message: string) => void;
const defaultWarn: Warn = (m) => console.warn(m);

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    // Accessing window.sessionStorage itself throws in some sandboxed contexts.
    return null;
  }
}

export function loadHostSecret(storage: Storage | null = defaultStorage(), warn: Warn = defaultWarn): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(HOST_SECRET_STORAGE_KEY)?.trim();
    return raw ? raw : null;
  } catch (error) {
    warn(`host: sessionStorage read failed (${describe(error)})`);
    return null;
  }
}

const listeners = new Set<() => void>();

/** Blank clears the stored secret. */
export function saveHostSecret(secret: string, storage: Storage | null = defaultStorage(), warn: Warn = defaultWarn): void {
  if (!storage) return;
  const trimmed = secret.trim();
  try {
    if (trimmed) storage.setItem(HOST_SECRET_STORAGE_KEY, trimmed);
    else storage.removeItem(HOST_SECRET_STORAGE_KEY);
  } catch (error) {
    warn(`host: sessionStorage write failed (${describe(error)})`);
  }
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const hasSecretSnapshot = (): boolean => loadHostSecret() !== null;
const serverSnapshot = (): boolean => false;

/** Whether a secret is stored: false on the server and during hydration, live afterwards. */
export function useHasHostSecret(): boolean {
  return useSyncExternalStore(subscribe, hasSecretSnapshot, serverSnapshot);
}

export function clearHostSecret(storage: Storage | null = defaultStorage(), warn: Warn = defaultWarn): void {
  saveHostSecret('', storage, warn);
}

export class HostClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'HostClientError';
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface StartSessionResponse {
  sessionId: bigint;
  txHash: Hash | null;
}

export interface FinalizeSessionResponse {
  sessionId: bigint;
  tokenId: bigint;
  contributors: bigint;
  txHash: Hash | null;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function bigintField(body: Record<string, unknown>, key: string): bigint | null {
  const v = body[key];
  return typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null;
}

function hashField(body: Record<string, unknown>): Hash | null | undefined {
  const v = body.txHash;
  if (v === null) return null;
  return typeof v === 'string' && HASH_RE.test(v) ? (v as Hash) : undefined;
}

async function post(path: string, secret: string | null, body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (secret) headers[HOST_HEADER] = secret;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method: 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch (error) {
    throw new HostClientError('BAD_RESPONSE', `${path} returned ${res.status} with a non-JSON body (${describe(error)})`, res.status);
  }
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  if (!res.ok) {
    const err = typeof record.error === 'object' && record.error !== null ? (record.error as { code?: unknown; message?: unknown }) : {};
    const code = typeof err.code === 'string' ? err.code : `HTTP_${res.status}`;
    const message = typeof err.message === 'string' ? err.message : `${path} failed with ${res.status}`;
    throw new HostClientError(code, message, res.status);
  }
  return record;
}

export async function startSessionRequest(secret: string | null): Promise<StartSessionResponse> {
  const body = await post('/api/session/start', secret);
  const sessionId = bigintField(body, 'sessionId');
  const txHash = hashField(body);
  if (sessionId === null || txHash === undefined) throw new HostClientError('BAD_RESPONSE', 'session/start returned an unexpected body', 200);
  return { sessionId, txHash };
}

export async function finalizeSessionRequest(secret: string | null, sessionId: bigint): Promise<FinalizeSessionResponse> {
  const body = await post('/api/session/finalize', secret, { sessionId: sessionId.toString() });
  const id = bigintField(body, 'sessionId');
  const tokenId = bigintField(body, 'tokenId');
  const contributors = bigintField(body, 'contributors');
  const txHash = hashField(body);
  if (id === null || tokenId === null || contributors === null || txHash === undefined) {
    throw new HostClientError('BAD_RESPONSE', 'session/finalize returned an unexpected body', 200);
  }
  return { sessionId: id, tokenId, contributors, txHash };
}

export interface ClaimHostResponse {
  sessionId: bigint;
  amountWei: bigint;
  txHash: Hash | null;
}

/** W21b: the host pulls its 20 % of the session's tips (claimHost, signed by the server's host key). */
export async function claimHostRequest(secret: string | null, sessionId: bigint): Promise<ClaimHostResponse> {
  const body = await post('/api/session/claim-host', secret, { sessionId: sessionId.toString() });
  const id = bigintField(body, 'sessionId');
  const amountWei = bigintField(body, 'amountWei');
  const txHash = hashField(body);
  if (id === null || amountWei === null || txHash === undefined) {
    throw new HostClientError('BAD_RESPONSE', 'session/claim-host returned an unexpected body', 200);
  }
  return { sessionId: id, amountWei, txHash };
}

export type { AgentStatus };

const isNullableNumber = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** W12: the DJ status body of /api/agent/*, checked field by field. */
function agentStatusOf(body: Record<string, unknown>, path: string): AgentStatus {
  const { running, sessionId, pid, startedAt, lines, hitsSent, budgetLeft, brain, lastExit } = body;
  if (
    typeof running !== 'boolean' ||
    !isNullableString(sessionId) ||
    !isNullableNumber(pid) ||
    !isNullableNumber(startedAt) ||
    !Array.isArray(lines) ||
    !lines.every((l): l is string => typeof l === 'string') ||
    !isNullableNumber(hitsSent) ||
    !isNullableNumber(budgetLeft) ||
    !isNullableString(brain) ||
    !isNullableString(lastExit)
  ) {
    throw new HostClientError('BAD_RESPONSE', `${path} returned an unexpected body`, 200);
  }
  return { running, sessionId, pid, startedAt, lines, hitsSent, budgetLeft, brain, lastExit };
}

export async function agentStartRequest(secret: string | null, sessionId: bigint): Promise<AgentStatus> {
  return agentStatusOf(await post('/api/agent/start', secret, { sessionId: sessionId.toString() }), 'agent/start');
}

export async function agentStopRequest(secret: string | null): Promise<AgentStatus> {
  return agentStatusOf(await post('/api/agent/stop', secret), 'agent/stop');
}

export async function agentStatusRequest(secret: string | null): Promise<AgentStatus> {
  return agentStatusOf(await post('/api/agent/status', secret), 'agent/status');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
