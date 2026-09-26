/**
 * Token bucket rate limiter. Every RPC call in the load test passes through one bucket so
 * the public Monad RPC limit (PUBLIC_RPC_RPS) is never exceeded. Clock and sleep are
 * injectable so tests run on a virtual clock.
 */
export interface TokenBucketOptions {
  ratePerSec: number;
  /** Burst size; defaults to one second of tokens. */
  capacity?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TokenBucketStats {
  granted: number;
  waited: number;
  waitedMs: number;
}

export interface TokenBucket {
  /** Resolves once a token has been granted; callers are served in arrival order. */
  take(): Promise<void>;
  /** Grants a token if one is available right now, otherwise returns false. */
  tryTake(): boolean;
  stats(): TokenBucketStats;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { ratePerSec } = options;
  if (!(ratePerSec > 0) || !Number.isFinite(ratePerSec)) {
    throw new Error(`ratePerSec must be a positive number, got ${String(ratePerSec)}`);
  }
  const capacity = options.capacity ?? Math.max(1, Math.floor(ratePerSec));
  if (!(capacity >= 1)) throw new Error(`capacity must be at least 1, got ${String(capacity)}`);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? realSleep;

  let tokens = capacity;
  let last = now();
  let tail: Promise<void> = Promise.resolve();
  const stats: TokenBucketStats = { granted: 0, waited: 0, waitedMs: 0 };

  function refill(): void {
    const t = now();
    if (t > last) {
      tokens = Math.min(capacity, tokens + ((t - last) * ratePerSec) / 1000);
      last = t;
    }
  }

  async function acquire(): Promise<void> {
    refill();
    if (tokens < 1) {
      const waitMs = Math.ceil(((1 - tokens) * 1000) / ratePerSec);
      stats.waited += 1;
      stats.waitedMs += waitMs;
      await sleep(waitMs);
      refill();
      // Guard against a sleep that returned early: top up by the exact deficit.
      if (tokens < 1) tokens = 1;
    }
    tokens -= 1;
    stats.granted += 1;
  }

  return {
    take(): Promise<void> {
      const turn = tail.then(acquire);
      // Keep the chain alive even if a caller's continuation throws.
      tail = turn.catch(() => undefined);
      return turn;
    },
    tryTake(): boolean {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      stats.granted += 1;
      return true;
    },
    stats(): TokenBucketStats {
      return { ...stats };
    },
  };
}
