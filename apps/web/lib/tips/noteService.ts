/**
 * W21b: the tip-note service behind /api/tip-note. A note is accepted once per tip
 * transaction, after the receipt proves the tip (lib/tips/verify.ts); in mock mode there is no
 * receipt, so the simulator tip the phone reports is taken as is (nothing of value moves).
 * Order matters: rate limit, then the duplicate checks, then the one RPC read, then the store.
 */
import type { Hash } from 'viem';
import type { TipNoteRequest } from './note';
import type { TipNote, TipNoteStore } from './noteStore';
import { RateLimitedError, type WindowRateLimiter } from './rateLimit';
import { TipVerifyError, type TipVerifyCode, type VerifiedTip } from './verify';

export type TipNoteErrorCode = 'RATE_LIMITED' | 'DUPLICATE' | 'RECEIPT_NOT_FOUND' | 'TX_REVERTED' | 'NOT_A_TIP' | 'RPC_ERROR' | 'NOTES_FULL' | 'INVALID_MOCK';

const STATUS: Record<TipNoteErrorCode, number> = {
  RATE_LIMITED: 429,
  DUPLICATE: 409,
  RECEIPT_NOT_FOUND: 404,
  TX_REVERTED: 422,
  NOT_A_TIP: 422,
  RPC_ERROR: 502,
  NOTES_FULL: 409,
  INVALID_MOCK: 400,
};

/** A receipt the node has not indexed yet is usually there a block or three later. */
export const RECEIPT_RETRY_AFTER_MS = 1_000;

export class TipNoteError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  override readonly cause: unknown;
  constructor(
    readonly code: TipNoteErrorCode,
    message: string,
    options: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'TipNoteError';
    this.status = STATUS[code];
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const FROM_VERIFY: Record<TipVerifyCode, TipNoteErrorCode> = {
  NOT_FOUND: 'RECEIPT_NOT_FOUND',
  REVERTED: 'TX_REVERTED',
  NOT_A_TIP: 'NOT_A_TIP',
  RPC_ERROR: 'RPC_ERROR',
};

export interface TipNoteService {
  submit(request: TipNoteRequest, ip: string): Promise<TipNote>;
  list(sessionId: bigint, limit: number): Promise<TipNote[]>;
}

export interface TipNoteServiceOptions {
  store: TipNoteStore;
  verify: (sessionId: bigint, txHash: Hash) => Promise<VerifiedTip>;
  mock: boolean;
  limiter: WindowRateLimiter;
  now?: () => number;
  /** Server log; RPC error text (which embeds the RPC URL) goes here, never to the client. */
  log?: (message: string) => void;
}

export function createTipNoteService(options: TipNoteServiceOptions): TipNoteService {
  const { store, verify, mock, limiter } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((m: string) => console.error(m));
  const inFlight = new Set<Hash>();

  async function proveTip(request: TipNoteRequest): Promise<VerifiedTip> {
    if (mock) {
      if (!request.mock) throw new TipNoteError('INVALID_MOCK', 'mock mode needs the simulator tip: { mock: { from, amountWei } }');
      return { from: request.mock.from, amountWei: request.mock.amountWei, blockNumber: 0n, hostWei: null, poolWei: null };
    }
    try {
      return await verify(request.sessionId, request.txHash);
    } catch (error) {
      if (!(error instanceof TipVerifyError)) throw error;
      if (error.code === 'RPC_ERROR') log(`tip-note: receipt read for ${request.txHash} failed: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`);
      throw new TipNoteError(FROM_VERIFY[error.code], error.message, error.code === 'NOT_FOUND' ? { retryAfterMs: RECEIPT_RETRY_AFTER_MS } : {});
    }
  }

  return {
    async submit(request, ip) {
      try {
        limiter.take(ip);
      } catch (error) {
        if (error instanceof RateLimitedError) throw new TipNoteError('RATE_LIMITED', error.message, { retryAfterMs: error.retryAfterMs });
        throw error;
      }
      const { txHash } = request;
      // Claimed before the first await, so two concurrent posts of one tx cannot both pass.
      if (inFlight.has(txHash)) throw new TipNoteError('DUPLICATE', 'this tip already has a note');
      inFlight.add(txHash);
      try {
        if (await store.has(txHash)) throw new TipNoteError('DUPLICATE', 'this tip already has a note');
        const tip = await proveTip(request);
        const note: TipNote = {
          sessionId: request.sessionId.toString(),
          txHash,
          from: tip.from,
          amountWei: tip.amountWei.toString(),
          hostWei: tip.hostWei === null ? null : tip.hostWei.toString(),
          poolWei: tip.poolWei === null ? null : tip.poolWei.toString(),
          blockNumber: tip.blockNumber.toString(),
          name: request.name,
          message: request.message,
          createdAt: now(),
        };
        const added = await store.add(note);
        if (added === 'duplicate') throw new TipNoteError('DUPLICATE', 'this tip already has a note');
        if (added !== 'added') throw new TipNoteError('NOTES_FULL', 'no room for more notes');
        return note;
      } finally {
        inFlight.delete(txHash);
      }
    },
    list(sessionId, limit) {
      return store.list(sessionId.toString(), limit);
    },
  };
}
