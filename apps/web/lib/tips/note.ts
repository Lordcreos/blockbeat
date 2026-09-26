/**
 * W21b: validation of POST /api/tip-note bodies and the note text rules. Notes are plain
 * text: trimmed, whitespace collapsed, control and bidi/invisible formatting characters
 * removed, cut at the limit in code points. Markup stays literal; React escapes it on render.
 */
import { getAddress, isAddress, type Address, type Hash } from 'viem';
import { parseSessionId } from '../types';
import { NOTE_MESSAGE_MAX, NOTE_NAME_MAX } from './constants';

/** Anything longer than this many UTF-16 units per allowed character is refused outright. */
const RAW_FACTOR = 4;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** C0/C1 controls (whitespace becomes a space first), bidi embeddings/isolates, zero-width marks. */
const STRIP_RE = /[\u0000-\u001F\u007F-\u009F​‎‏‪-‮⁠⁦-⁩﻿؜]/g;
/** Largest mock amount accepted (10 MON): bounds the displayed figures in mock mode. */
const MOCK_MAX_WEI = 10n ** 19n;

export function cleanNoteText(raw: string | null | undefined, max: number): string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.normalize('NFC').replace(/\s+/g, ' ').replace(STRIP_RE, '').replace(/ {2,}/g, ' ').trim();
  if (text === '') return null;
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('').trimEnd();
}

export interface MockTipFields {
  from: Address;
  amountWei: bigint;
}

export interface TipNoteRequest {
  sessionId: bigint;
  /** Lower-cased: the store's one-note-per-tx key. */
  txHash: Hash;
  name: string | null;
  message: string | null;
  /** Mock mode only: the simulator tip the phone saw (no receipt exists to read it from). */
  mock: MockTipFields | null;
}

export type TipNoteParseCode = 'INVALID_BODY' | 'INVALID_SESSION' | 'INVALID_TX_HASH' | 'INVALID_NAME' | 'INVALID_MESSAGE' | 'INVALID_MOCK';

export type TipNoteParse = { ok: true; value: TipNoteRequest } | { ok: false; code: TipNoteParseCode; message: string };

function fail(code: TipNoteParseCode, message: string): TipNoteParse {
  return { ok: false, code, message };
}

function sessionOf(raw: unknown): bigint | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? BigInt(raw) : null;
  if (typeof raw === 'string' && raw.length <= 78) return parseSessionId(raw);
  return null;
}

/** Optional text field: absent/null → null, a string → cleaned, anything else → invalid. */
function textOf(raw: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string' || raw.length > max * RAW_FACTOR) return { ok: false };
  return { ok: true, value: cleanNoteText(raw, max) };
}

function mockOf(raw: unknown): MockTipFields | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return 'invalid';
  const { from, amountWei } = raw as { from?: unknown; amountWei?: unknown };
  if (typeof from !== 'string' || !isAddress(from)) return 'invalid';
  if (typeof amountWei !== 'string' || !/^\d{1,20}$/.test(amountWei)) return 'invalid';
  const amount = BigInt(amountWei);
  if (amount <= 0n || amount > MOCK_MAX_WEI) return 'invalid';
  return { from: getAddress(from), amountWei: amount };
}

export function parseTipNoteBody(body: unknown, options: { allowMock?: boolean } = {}): TipNoteParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('INVALID_BODY', 'body must be JSON { "sessionId", "txHash", "name"?, "message"? }');
  }
  const fields = body as { sessionId?: unknown; txHash?: unknown; name?: unknown; message?: unknown; mock?: unknown };
  const sessionId = sessionOf(fields.sessionId);
  if (sessionId === null) return fail('INVALID_SESSION', 'sessionId must be a positive integer');
  if (typeof fields.txHash !== 'string' || !TX_HASH_RE.test(fields.txHash)) {
    return fail('INVALID_TX_HASH', 'txHash must be a 0x-prefixed 32-byte hex string');
  }
  const name = textOf(fields.name, NOTE_NAME_MAX);
  if (!name.ok) return fail('INVALID_NAME', `name must be text of at most ${NOTE_NAME_MAX} characters`);
  const message = textOf(fields.message, NOTE_MESSAGE_MAX);
  if (!message.ok) return fail('INVALID_MESSAGE', `message must be text of at most ${NOTE_MESSAGE_MAX} characters`);
  let mock: MockTipFields | null = null;
  if (options.allowMock) {
    const parsed = mockOf(fields.mock);
    if (parsed === 'invalid') return fail('INVALID_MOCK', 'mock must be { from: address, amountWei: decimal string }');
    mock = parsed;
  }
  return {
    ok: true,
    value: { sessionId, txHash: fields.txHash.toLowerCase() as Hash, name: name.value, message: message.value, mock },
  };
}
