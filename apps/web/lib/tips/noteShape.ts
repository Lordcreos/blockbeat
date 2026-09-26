/**
 * W21b: the tip note record as stored (lib/tips/noteStore.ts) and served by /api/tip-note.
 * Client-safe (no node imports): the stage and the track page parse the GET answer with it.
 * Amounts and blocks are decimal strings (bigint-safe); createdAt is epoch ms, server clock.
 */
import type { Address, Hash } from 'viem';
import { NOTE_MESSAGE_MAX, NOTE_NAME_MAX } from './constants';

export interface TipNote {
  sessionId: string;
  txHash: Hash;
  from: Address;
  amountWei: string;
  /** W21a TipSplit amounts when the receipt carried them; null before W21a. */
  hostWei: string | null;
  poolWei: string | null;
  blockNumber: string;
  name: string | null;
  message: string | null;
  createdAt: number;
}

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^\d{1,78}$/;

function optionalText(v: unknown, max: number): boolean {
  return v === null || (typeof v === 'string' && v.length > 0 && [...v].length <= max);
}

function optionalUint(v: unknown): boolean {
  return v === null || (typeof v === 'string' && UINT_RE.test(v));
}

export function isTipNote(v: unknown): v is TipNote {
  if (typeof v !== 'object' || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.sessionId === 'string' && UINT_RE.test(n.sessionId) &&
    typeof n.txHash === 'string' && HASH_RE.test(n.txHash) &&
    typeof n.from === 'string' && ADDRESS_RE.test(n.from) &&
    typeof n.amountWei === 'string' && UINT_RE.test(n.amountWei) &&
    optionalUint(n.hostWei) && optionalUint(n.poolWei) &&
    typeof n.blockNumber === 'string' && UINT_RE.test(n.blockNumber) &&
    optionalText(n.name, NOTE_NAME_MAX) && optionalText(n.message, NOTE_MESSAGE_MAX) &&
    typeof n.createdAt === 'number' && Number.isFinite(n.createdAt)
  );
}
