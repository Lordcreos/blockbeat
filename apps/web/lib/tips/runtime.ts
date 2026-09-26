/**
 * W21b: process-wide tip-note store and service for the API route and the track page. The
 * store file is apps/web/.data/tip-notes.json (gitignored) unless TIP_NOTES_FILE says
 * otherwise; receipts are read over MONAD_RPC_URL (server) or the public RPC. Server only.
 */
import path from 'node:path';
import { createHttpClient, getRpcUrls, isMockMode, runtimeAddress } from '../chain/clients';
import { createTipNoteService, type TipNoteService } from './noteService';
import { createTipNoteStore, type TipNoteStore } from './noteStore';
import { createWindowRateLimiter, type WindowRateLimiter } from './rateLimit';
import { verifyTipTx } from './verify';

/** Posts per IP per minute (a room behind one carrier NAT tips far less often than it joins). */
export const DEFAULT_NOTE_POSTS_PER_MINUTE_PER_IP = 30;
export const DEFAULT_NOTE_POSTS_PER_MINUTE_GLOBAL = 600;
/** Reads: the stage polls every few seconds; this only stops a runaway client. */
export const NOTE_READS_PER_MINUTE_PER_IP = 240;
export const NOTE_READS_PER_MINUTE_GLOBAL = 6_000;

export function envPositiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return Number(raw);
}

export function tipNotesFile(env: Record<string, string | undefined> = process.env): string {
  return env.TIP_NOTES_FILE?.trim() || path.join(process.cwd(), '.data', 'tip-notes.json');
}

let store: TipNoteStore | null = null;
let service: TipNoteService | null = null;
let readLimiter: WindowRateLimiter | null = null;

export function getTipNoteStore(): TipNoteStore {
  store ??= createTipNoteStore({ file: tipNotesFile() });
  return store;
}

export function getTipNoteService(): TipNoteService {
  if (service) return service;
  const mock = isMockMode();
  const client = mock ? null : createHttpClient(process.env.MONAD_RPC_URL?.trim() || getRpcUrls().http);
  const address = runtimeAddress();
  service = createTipNoteService({
    store: getTipNoteStore(),
    mock,
    verify: (sessionId, txHash) => {
      if (!client) throw new Error('tip-note: no RPC client in mock mode');
      return verifyTipTx({ client, address, sessionId, txHash });
    },
    limiter: createWindowRateLimiter({
      perKey: envPositiveInt(process.env, 'TIP_NOTE_MAX_PER_MINUTE_PER_IP', DEFAULT_NOTE_POSTS_PER_MINUTE_PER_IP),
      global: envPositiveInt(process.env, 'TIP_NOTE_MAX_PER_MINUTE_GLOBAL', DEFAULT_NOTE_POSTS_PER_MINUTE_GLOBAL),
    }),
  });
  return service;
}

export function getTipNoteReadLimiter(): WindowRateLimiter {
  readLimiter ??= createWindowRateLimiter({ perKey: NOTE_READS_PER_MINUTE_PER_IP, global: NOTE_READS_PER_MINUTE_GLOBAL });
  return readLimiter;
}
