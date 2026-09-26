/**
 * Lightweight head subscription for the agent: tracks the current block, measures the
 * block cadence from head arrival times and predicts which block will be current in N ms.
 * No audio scheduler here (that lives in apps/web); the agent only needs to know when to
 * send so a transaction lands on a chosen block.
 */
import { BLOCK_MS } from '@blockbeat/shared';

export type HeadSourceKind = 'ws' | 'poll';

export interface HeadSource {
  kind(): HeadSourceKind;
  subscribe(onHead: (blockNumber: bigint) => void, onError: (error: Error) => void): () => void;
}

export interface BlockClockOptions {
  headSource: HeadSource;
  /** Wall clock in ms; injectable for tests. */
  now?: () => number;
  /** Initial cadence until enough heads have been measured. */
  blockMs?: number;
  /** Heads kept for the cadence measurement. */
  historySize?: number;
}

export interface BlockClock {
  start(): void;
  stop(): void;
  locked(): boolean;
  currentBlock(): bigint;
  measuredBlockMs(): number;
  source(): HeadSourceKind;
  /** Block expected to be current `ms` from now. */
  predictBlockIn(ms: number): bigint;
  /** Milliseconds until `block` becomes current; 0 if it already is or has passed. */
  msUntilBlock(block: bigint): number;
  onHead(cb: (blockNumber: bigint) => void): () => void;
  onError(cb: (error: Error) => void): () => void;
}

const MIN_BLOCK_MS = 100;
const MAX_BLOCK_MS = 5000;
/** Heads needed before the measured cadence replaces the nominal one. */
const MIN_SAMPLES = 8;

interface HeadSample {
  block: bigint;
  at: number;
}

export function createBlockClock(options: BlockClockOptions): BlockClock {
  const { headSource } = options;
  const now = options.now ?? (() => Date.now());
  const historySize = options.historySize ?? 32;

  let blockMs = options.blockMs ?? BLOCK_MS;
  let currentBlock = 0n;
  let lastHeadAt: number | null = null;
  let unsubscribe: (() => void) | null = null;
  const history: HeadSample[] = [];
  const headListeners = new Set<(blockNumber: bigint) => void>();
  const errorListeners = new Set<(error: Error) => void>();

  function measure(): void {
    if (history.length < MIN_SAMPLES) return;
    const first = history[0];
    const last = history[history.length - 1];
    if (!first || !last) return;
    const blocks = Number(last.block - first.block);
    if (blocks <= 0) return;
    blockMs = Math.min(MAX_BLOCK_MS, Math.max(MIN_BLOCK_MS, (last.at - first.at) / blocks));
  }

  function onHead(block: bigint): void {
    if (!unsubscribe) return; // stopped
    if (lastHeadAt !== null && block <= currentBlock) return;
    const at = now();
    currentBlock = block;
    lastHeadAt = at;
    history.push({ block, at });
    while (history.length > historySize) history.shift();
    measure();
    for (const cb of headListeners) cb(block);
  }

  function onError(error: Error): void {
    for (const cb of errorListeners) cb(error);
  }

  function elapsed(): number {
    return lastHeadAt === null ? 0 : Math.max(0, now() - lastHeadAt);
  }

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = () => undefined; // mark running before subscribe: a source may emit synchronously
      unsubscribe = headSource.subscribe(onHead, onError);
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
    locked: () => lastHeadAt !== null,
    currentBlock: () => currentBlock,
    measuredBlockMs: () => blockMs,
    source: () => headSource.kind(),
    predictBlockIn(ms) {
      return currentBlock + BigInt(Math.floor((elapsed() + ms) / blockMs));
    },
    msUntilBlock(block) {
      const ahead = Number(block - currentBlock);
      if (ahead <= 0) return 0;
      return Math.max(0, ahead * blockMs - elapsed());
    },
    onHead(cb) {
      headListeners.add(cb);
      return () => headListeners.delete(cb);
    },
    onError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
  };
}
