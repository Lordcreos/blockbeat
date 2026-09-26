import { describe, expect, it } from 'vitest';
import { RateLimitedError, createWindowRateLimiter } from './rateLimit';

describe('createWindowRateLimiter (W21b)', () => {
  it('admits up to the per-key limit inside the window, then refuses with a retry delay', () => {
    let t = 1_000;
    const limiter = createWindowRateLimiter({ perKey: 2, global: 100, windowMs: 60_000, now: () => t });
    limiter.take('1.1.1.1');
    t += 10;
    limiter.take('1.1.1.1');
    t += 10;
    let caught: unknown = null;
    try {
      limiter.take('1.1.1.1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).retryAfterMs).toBe(60_000 - 20);
    expect(() => limiter.take('2.2.2.2')).not.toThrow();
  });

  it('frees a slot once the oldest stamp leaves the window', () => {
    let t = 0;
    const limiter = createWindowRateLimiter({ perKey: 1, global: 100, windowMs: 1_000, now: () => t });
    limiter.take('a');
    expect(() => limiter.take('a')).toThrow(RateLimitedError);
    t = 1_001;
    expect(() => limiter.take('a')).not.toThrow();
  });

  it('caps all keys together with the global limit', () => {
    const limiter = createWindowRateLimiter({ perKey: 10, global: 2, windowMs: 1_000, now: () => 0 });
    limiter.take('a');
    limiter.take('b');
    expect(() => limiter.take('c')).toThrow(/in total/);
  });

  it('forgets idle keys so memory stays bounded', () => {
    let t = 0;
    const limiter = createWindowRateLimiter({ perKey: 5, global: 1_000, windowMs: 1_000, now: () => t });
    for (let i = 0; i < 50; i++) limiter.take(`ip-${i}`);
    expect(limiter.size()).toBe(50);
    t = 5_000;
    limiter.take('fresh');
    expect(limiter.size()).toBe(1);
  });
});
