/**
 * Tip sender: sends `tip(sessionId)` with a FIXED value and gas limit (never eth_estimateGas)
 * and resolves once the transaction receipt is seen, reporting the landing block and latency.
 * The contract rejects tips to sessions with no hits (`NoHits`); that revert is surfaced as
 * a typed `NO_HITS` error so the join page can explain it.
 *
 * W11 (Monad reserve balance): a burner holds well under 10 MON, so a value-carrying tip only
 * lands if the burner sent nothing (hit or tip) in the previous 3 blocks. With `activity`
 * the tip waits until TIP_RESERVE_GUARD_MS after the burner's last send, inside the tip timeout.
 */
import { parseEther, type Hash } from 'viem';
import { BLOCK_MS, RESERVE_PACING_BLOCKS } from '@blockbeat/shared';
import { revertErrorName } from './revert';
import type { TipReceipt, TipSender } from './types';

/** Fixed audience tip. Product constant of the web app, not part of the contract interface. */
export const TIP_AMOUNT_MON = '0.005';

/** Custom error the contract raises for a tip to a session without hits (decoded by name, review H10). */
const NO_HITS = 'NoHits';

export type TipErrorCode = 'INVALID_ARGS' | 'SEND_FAILED' | 'TIMEOUT' | 'NO_HITS';

export class TipError extends Error {
  readonly code: TipErrorCode;
  readonly txHash: Hash | null;
  override readonly cause: unknown;

  constructor(code: TipErrorCode, message: string, options: { cause?: unknown; txHash?: Hash | null } = {}) {
    super(message);
    this.name = 'TipError';
    this.code = code;
    this.txHash = options.txHash ?? null;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Quiet time a burner needs before a tip: the reserve window plus inclusion slack. */
export const TIP_RESERVE_GUARD_MS = RESERVE_PACING_BLOCKS * BLOCK_MS;

/** The burner's most recent transaction send time, shared by the hit and tip paths. */
export interface BurnerActivity {
  lastSendAt(): number | null;
  markSend(at: number): void;
}

export function createBurnerActivity(): BurnerActivity {
  let last: number | null = null;
  return {
    lastSendAt: () => last,
    markSend(at) {
      last = last === null ? at : Math.max(last, at);
    },
  };
}

/**
 * W12: when a tip from this burner could go out (the phone's reserve-rule countdown), or null
 * when it could go now.
 */
export function tipReadyAt(activity: BurnerActivity, now: number): number | null {
  const last = activity.lastSendAt();
  if (last === null) return null;
  const at = last + TIP_RESERVE_GUARD_MS;
  return at > now ? at : null;
}

export interface TipWriteArgs {
  sessionId: bigint;
  valueWei: bigint;
}

/** Sends the tip transaction and returns its hash. Chain-backed in lib/chain, in-memory in the simulator. */
export type TipWriter = (args: TipWriteArgs) => Promise<Hash>;

export interface TipReceiptSource {
  waitForReceipt(txHash: Hash): Promise<{ blockNumber: bigint; status: 'success' | 'reverted' }>;
  /**
   * Optional: after an onchain revert, re-simulate the same call and return the decoded
   * custom error name (`NoHits`, `ZeroTip`…) or, failing that, a short reason text (with a
   * fixed gas limit viem never simulates before sending, so a hitless session only shows up
   * as a reverted receipt). Rare path: one eth_call per failed tip.
   */
  explainRevert?(args: TipWriteArgs): Promise<string>;
}

export interface TipSenderOptions {
  writer: TipWriter;
  receipts: TipReceiptSource;
  timeoutMs?: number;
  now?: () => number;
  amountMon?: string;
  activity?: BurnerActivity;
}

export const DEFAULT_TIP_TIMEOUT_MS = 15_000;

export function createTipSender(options: TipSenderOptions): TipSender {
  const { writer, receipts } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIP_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const amountWei = parseEther(options.amountMon ?? TIP_AMOUNT_MON);
  const activity = options.activity;
  let inFlight = 0;
  let gate: Promise<unknown> = Promise.resolve();

  /** Resolves once the burner has been quiet for TIP_RESERVE_GUARD_MS (re-checks: a tap may land meanwhile). */
  async function reserveWindowClear(isSettled: () => boolean): Promise<void> {
    for (;;) {
      const last = activity?.lastSendAt() ?? null;
      const wait = last === null ? 0 : last + TIP_RESERVE_GUARD_MS - now();
      if (wait <= 0 || isSettled()) return;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  function toError(error: unknown): TipError {
    const name = revertErrorName(error);
    if (name === NO_HITS) {
      return new TipError('NO_HITS', 'the session has no hits yet, nothing to tip', { cause: error });
    }
    if (name !== null) return new TipError('SEND_FAILED', `tip reverted: ${name}`, { cause: error });
    const message = error instanceof Error ? error.message : String(error);
    return new TipError('SEND_FAILED', `tip send failed: ${message}`, { cause: error });
  }

  /** Classify an onchain revert; without a diagnosis it stays a generic SEND_FAILED. */
  async function explainReverted(sessionId: bigint, txHash: Hash): Promise<TipError> {
    if (!receipts.explainRevert) return new TipError('SEND_FAILED', 'tip transaction reverted', { txHash });
    let reason: string;
    try {
      reason = await receipts.explainRevert({ sessionId, valueWei: amountWei });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new TipError('SEND_FAILED', `tip transaction reverted (diagnosis failed: ${message})`, { cause: error, txHash });
    }
    if (reason === NO_HITS) return new TipError('NO_HITS', 'the session has no hits yet, nothing to tip', { txHash });
    return new TipError('SEND_FAILED', `tip transaction reverted: ${reason}`, { txHash });
  }

  function send(sessionId: bigint): Promise<TipReceipt> {
    if (sessionId <= 0n) {
      return Promise.reject(new TipError('INVALID_ARGS', `sessionId must be positive, got ${sessionId}`));
    }
    inFlight += 1;
    return new Promise<TipReceipt>((resolve, reject) => {
      let sentAt = now();
      let txHash: Hash | null = null;
      let settled = false;
      const timer = setTimeout(() => {
        fail(new TipError('TIMEOUT', `no receipt within ${timeoutMs} ms`, { txHash }));
      }, timeoutMs);

      function cleanup(): void {
        settled = true;
        clearTimeout(timer);
        inFlight -= 1;
      }
      function fail(error: TipError): void {
        if (settled) return;
        cleanup();
        reject(error);
      }
      function finish(receipt: TipReceipt): void {
        if (settled) return;
        cleanup();
        resolve(receipt);
      }

      // One tip at a time through the reserve gate, so two overlapping tips cannot both pass
      // the window check before either marks its send. false = timed out while waiting.
      const cleared = gate
        .then(() => reserveWindowClear(() => settled))
        .then(() => {
          if (settled) return false;
          sentAt = now();
          activity?.markSend(sentAt);
          return true;
        });
      gate = cleared.catch(() => undefined);
      cleared
        .then((go) => (go ? writer({ sessionId, valueWei: amountWei }) : null))
        .then(
        (hash) => {
          if (settled || hash === null) return;
          txHash = hash;
          receipts.waitForReceipt(hash).then(
            (receipt) => {
              if (receipt.status !== 'success') {
                explainReverted(sessionId, hash).then(fail, (error: unknown) => fail(toError(error)));
                return;
              }
              finish({ txHash: hash, blockNumber: receipt.blockNumber, amountWei, latencyMs: Math.max(0, now() - sentAt) });
            },
            (error: unknown) => fail(new TipError('SEND_FAILED', `receipt lookup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error, txHash: hash })),
          );
        },
        (error: unknown) => fail(toError(error)),
      );
    });
  }

  return { send, pending: () => inFlight };
}
