import { describe, expect, it } from 'vitest';
import { createTokenBucket } from '../src/lib/tokenBucket';

/** Virtual clock: sleep advances time instantly so tests never wait. */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('token bucket', () => {
  it('grants up to capacity immediately', async () => {
    const clock = virtualClock();
    const bucket = createTokenBucket({ ratePerSec: 10, capacity: 5, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 5; i++) await bucket.take();
    expect(clock.now()).toBe(0);
    expect(bucket.stats().granted).toBe(5);
    expect(bucket.stats().waited).toBe(0);
  });

  it('waits one refill interval once the bucket is empty', async () => {
    const clock = virtualClock();
    const bucket = createTokenBucket({ ratePerSec: 10, capacity: 5, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 5; i++) await bucket.take();
    await bucket.take();
    expect(clock.now()).toBe(100);
    expect(bucket.stats().waited).toBe(1);
    expect(bucket.stats().waitedMs).toBe(100);
  });

  it('never exceeds capacity plus rate times elapsed over a burst of concurrent takers', async () => {
    const clock = virtualClock();
    const ratePerSec = 50;
    const capacity = 50;
    const bucket = createTokenBucket({ ratePerSec, capacity, now: clock.now, sleep: clock.sleep });
    const grantedAt: number[] = [];
    await Promise.all(
      Array.from({ length: 200 }, () => bucket.take().then(() => grantedAt.push(clock.now()))),
    );
    expect(grantedAt).toHaveLength(200);
    // For every grant, the count of grants at or before its time must respect the bucket law.
    const sorted = [...grantedAt].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i] ?? 0;
      const allowed = capacity + (t * ratePerSec) / 1000;
      expect(i + 1).toBeLessThanOrEqual(allowed + 1e-9);
    }
    // 200 takes at 50 rps with 50 burst: the last one waits at least 3 s.
    expect(sorted[sorted.length - 1]).toBeGreaterThanOrEqual(3000);
  });

  it('refills while idle, capped at capacity', async () => {
    const clock = virtualClock();
    const bucket = createTokenBucket({ ratePerSec: 10, capacity: 3, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 3; i++) await bucket.take();
    clock.advance(10_000);
    for (let i = 0; i < 3; i++) await bucket.take();
    expect(bucket.stats().waited).toBe(0);
    await bucket.take();
    expect(bucket.stats().waited).toBe(1);
  });

  it('tryTake returns false instead of waiting', () => {
    const clock = virtualClock();
    const bucket = createTokenBucket({ ratePerSec: 10, capacity: 1, now: clock.now, sleep: clock.sleep });
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    expect(clock.now()).toBe(0);
  });

  it('rejects a non-positive rate', () => {
    expect(() => createTokenBucket({ ratePerSec: 0 })).toThrow(/ratePerSec/);
  });
});
