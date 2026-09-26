/**
 * W21b: sliding-window rate limit per key (client IP) and in total, in memory. Used by the
 * tip-note route and the tipper drip; the player drip keeps its own (review C4 reservations).
 */
export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = 'RateLimitedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface WindowRateLimiterOptions {
  perKey: number;
  global: number;
  windowMs?: number;
  now?: () => number;
}

export interface WindowRateLimiter {
  /** Counts one request for `key` or throws RateLimitedError (nothing is counted then). */
  take(key: string): void;
  /** Keys with stamps still tracked (tests and stats). */
  size(): number;
}

export function createWindowRateLimiter(options: WindowRateLimiterOptions): WindowRateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const perKey = new Map<string, number[]>();
  let all: number[] = [];
  let lastSweep = 0;

  function refuse(stamps: number[], t: number, message: string): never {
    const oldest = stamps[0] ?? t;
    throw new RateLimitedError(message, Math.max(1, oldest + windowMs - t));
  }

  function sweep(t: number): void {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [key, stamps] of perKey) {
      if (!stamps.some((s) => s > t - windowMs)) perKey.delete(key);
    }
  }

  return {
    take(key) {
      const t = now();
      sweep(t);
      all = all.filter((s) => s > t - windowMs);
      if (all.length >= options.global) refuse(all, t, `more than ${options.global} requests per minute in total`);
      const stamps = (perKey.get(key) ?? []).filter((s) => s > t - windowMs);
      if (stamps.length >= options.perKey) {
        perKey.set(key, stamps);
        refuse(stamps, t, `more than ${options.perKey} requests per minute from this address`);
      }
      stamps.push(t);
      perKey.set(key, stamps);
      all.push(t);
    },
    size: () => perKey.size,
  };
}
