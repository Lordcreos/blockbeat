/**
 * Hit sender: signs and sends `hit(session, track, note)` with a FIXED gas limit
 * (never eth_estimateGas: that endpoint has the tighter public rate limit), records
 * `sentAt`, and resolves when the `Hit` log for that transaction hash is seen on the
 * event stream, reporting the landing block, step, on-flag and latency.
 */
import { isNote, isTrackId, type HitEvent, type TrackId } from '@blockbeat/shared';
import type { Hash } from 'viem';
import { sharedLatency, type LatencyTracker } from './latency';
import type { HitReceipt, HitSender } from './types';

export type HitErrorCode = 'INVALID_ARGS' | 'SEND_FAILED' | 'TIMEOUT';

export class HitError extends Error {
  readonly code: HitErrorCode;
  readonly txHash: Hash | null;
  override readonly cause: unknown;

  constructor(code: HitErrorCode, message: string, options: { cause?: unknown; txHash?: Hash | null } = {}) {
    super(message);
    this.name = 'HitError';
    this.code = code;
    this.txHash = options.txHash ?? null;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface HitWriteArgs {
  sessionId: bigint;
  track: TrackId;
  note: number;
}

/**
 * What a writer may report after it has already returned the hash (the chain writer
 * watches the receipt off the send path, review H7): a replacement hash when it retried
 * the send with more gas, or a revert of the hash the sender is waiting on.
 */
export interface HitWriteHooks {
  onRetry?(hash: Hash): void;
  onReverted?(hash: Hash, message: string): void;
}

/** Sends the transaction and returns its hash. Chain-backed in lib/chain, in-memory in the simulator. */
export type HitWriter = (args: HitWriteArgs, hooks?: HitWriteHooks) => Promise<Hash>;

/** Anything that emits decoded Hit events, typically the EventFeed. */
export interface HitStream {
  onHit(cb: (hit: HitEvent) => void): () => void;
}

export interface HitSenderOptions {
  writer: HitWriter;
  hits: HitStream;
  timeoutMs?: number;
  now?: () => number;
  latency?: LatencyTracker;
}

export const DEFAULT_HIT_TIMEOUT_MS = 15_000;

export function createHitSender(options: HitSenderOptions): HitSender {
  const { writer, hits } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HIT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const latency = options.latency ?? sharedLatency;
  let inFlight = 0;

  function send(sessionId: bigint, track: TrackId, note: number): Promise<HitReceipt> {
    if (!isTrackId(track)) {
      return Promise.reject(new HitError('INVALID_ARGS', `track must be 0..7, got ${String(track)}`));
    }
    if (!isNote(note)) {
      return Promise.reject(new HitError('INVALID_ARGS', `note must be 0..31, got ${String(note)}`));
    }

    inFlight += 1;
    return new Promise<HitReceipt>((resolve, reject) => {
      const sentAt = now();
      let txHash: Hash | null = null;
      /** The hash sent plus any replacement the writer retried with; a Hit for either settles the tap. */
      const hashes = new Set<Hash>();
      /** Hits seen before the hash is known; checked once the writer returns. */
      const early: HitEvent[] = [];
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const off = hits.onHit((hit) => {
        if (settled) return;
        if (txHash === null) {
          early.push(hit);
          return;
        }
        if (hashes.has(hit.txHash)) finish(hit);
      });

      function cleanup(): void {
        settled = true;
        off();
        if (timer !== null) clearTimeout(timer);
        inFlight -= 1;
      }

      function finish(hit: HitEvent): void {
        const latencyMs = Math.max(0, now() - sentAt);
        cleanup();
        latency.record(latencyMs);
        resolve({ txHash: hit.txHash, blockNumber: hit.blockNumber, step: hit.step, on: hit.on, latencyMs });
      }

      function fail(error: HitError): void {
        cleanup();
        reject(error);
      }

      timer = setTimeout(() => {
        if (!settled) fail(new HitError('TIMEOUT', `no Hit log within ${timeoutMs} ms`, { txHash }));
      }, timeoutMs);

      const hooks: HitWriteHooks = {
        onRetry(hash) {
          if (settled) return;
          hashes.add(hash);
          txHash = hash;
          const match = early.find((h) => hashes.has(h.txHash));
          if (match) finish(match);
        },
        onReverted(hash, message) {
          if (settled || hash !== txHash) return;
          fail(new HitError('SEND_FAILED', `hit send failed: ${message}`, { txHash: hash }));
        },
      };

      writer({ sessionId, track, note }, hooks).then(
        (hash) => {
          if (settled) return;
          txHash = hash;
          hashes.add(hash);
          const match = early.find((h) => hashes.has(h.txHash));
          if (match) finish(match);
        },
        (error: unknown) => {
          if (settled) return;
          const message = error instanceof Error ? error.message : String(error);
          fail(new HitError('SEND_FAILED', `hit send failed: ${message}`, { cause: error }));
        },
      );
    });
  }

  return {
    send,
    pending: () => inFlight,
  };
}
