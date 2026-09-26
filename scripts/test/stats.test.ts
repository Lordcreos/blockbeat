import { describe, expect, it } from 'vitest';
import { HttpRequestError, RpcRequestError, TimeoutError } from 'viem';
import { aggregate, classifyRpcError, percentile, type HitRecord } from '../src/lib/stats';

function confirmed(i: number, latencyMs: number, intendedStep: number, actualStep: number): HitRecord {
  return {
    wallet: i % 4,
    index: i,
    sentAt: 1000 + i,
    receiptAt: 1000 + i + latencyMs,
    blockNumber: 200n + BigInt(i),
    intendedStep,
    actualStep,
    latencyMs,
    status: 'confirmed',
    gasUsed: 60_000n,
    effectiveGasPrice: 50_000_000_000n,
  };
}

describe('percentile (nearest rank)', () => {
  it('returns the single value for one sample', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });

  it('computes p50/p95/p99 over 1..100', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 99)).toBe(99);
  });

  it('does not require sorted input', () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
  });

  it('returns null for an empty sample', () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe('classifyRpcError', () => {
  it('flags HTTP 429 as rate limited', () => {
    const err = new HttpRequestError({ url: 'http://x', status: 429, details: 'Too Many Requests' });
    const out = classifyRpcError(err);
    expect(out.rateLimited).toBe(true);
    expect(out.code).toBe('HTTP_429');
  });

  it('uses the JSON-RPC error code when present', () => {
    const err = new RpcRequestError({
      body: {},
      url: 'http://x',
      error: { code: -32000, message: 'insufficient funds for gas * price + value' },
    });
    const out = classifyRpcError(err);
    expect(out.code).toBe('RPC_-32000');
    expect(out.rateLimited).toBe(false);
    expect(out.message).toContain('insufficient funds');
  });

  it('flags a rate-limit message even without a status', () => {
    const err = new RpcRequestError({
      body: {},
      url: 'http://x',
      error: { code: -32005, message: 'rate limit exceeded' },
    });
    expect(classifyRpcError(err).rateLimited).toBe(true);
  });

  it('classifies viem timeouts', () => {
    const err = new TimeoutError({ body: {}, url: 'http://x' });
    expect(classifyRpcError(err).code).toBe('TIMEOUT');
  });

  it('classifies unknown throwables without losing the message', () => {
    expect(classifyRpcError(new Error('boom')).code).toBe('Error');
    expect(classifyRpcError('weird')).toEqual({ code: 'UNKNOWN', rateLimited: false, message: 'weird' });
  });
});

describe('aggregate', () => {
  const records: HitRecord[] = [
    confirmed(0, 400, 3, 3),
    confirmed(1, 500, 4, 4),
    confirmed(2, 900, 5, 6),
    confirmed(3, 1200, 6, 8),
    {
      wallet: 0,
      index: 4,
      sentAt: 2000,
      intendedStep: 7,
      status: 'send-failed',
      errorCode: 'HTTP_429',
      rateLimited: true,
      errorMessage: 'Too Many Requests',
    },
    {
      wallet: 1,
      index: 5,
      sentAt: 2001,
      intendedStep: 7,
      status: 'send-failed',
      errorCode: 'RPC_-32000',
      rateLimited: false,
      errorMessage: 'insufficient funds',
    },
    { wallet: 2, index: 6, sentAt: 2002, intendedStep: 8, status: 'timeout' },
  ];
  const money = { fundedWei: 10n ** 18n, funderSpentWei: 10n ** 18n + 21_000n * 10n ** 9n, burnerSpentWei: 4n * 60_000n * 50_000_000_000n };
  const summary = aggregate(records, { ...money, durationMs: 60_000, bucketWaits: 12, bucketWaitedMs: 800 });

  it('counts outcomes', () => {
    expect(summary.hits.total).toBe(7);
    expect(summary.hits.confirmed).toBe(4);
    expect(summary.hits.sendFailed).toBe(2);
    expect(summary.hits.timedOut).toBe(1);
    expect(summary.hits.reverted).toBe(0);
  });

  it('computes latency percentiles from confirmed hits only', () => {
    expect(summary.latencyMs.p50).toBe(500);
    expect(summary.latencyMs.p95).toBe(1200);
    expect(summary.latencyMs.p99).toBe(1200);
    expect(summary.latencyMs.min).toBe(400);
    expect(summary.latencyMs.max).toBe(1200);
    expect(summary.latencyMs.mean).toBe(750);
  });

  it('groups errors by code with rate-limit hits counted separately', () => {
    expect(summary.errors).toEqual([
      { code: 'HTTP_429', count: 1, rateLimited: true, sample: 'Too Many Requests' },
      { code: 'RPC_-32000', count: 1, rateLimited: false, sample: 'insufficient funds' },
    ]);
    expect(summary.rateLimitHits).toBe(1);
  });

  it('reports on-time versus late landings', () => {
    expect(summary.landing.onTime).toBe(2);
    expect(summary.landing.oneLate).toBe(1);
    expect(summary.landing.late).toBe(1);
    expect(summary.landing.early).toBe(0);
    expect(summary.landing.onTimeRatio).toBeCloseTo(0.5);
    expect(summary.landing.withinOneStepRatio).toBeCloseTo(0.75);
  });

  it('reports money as decimal MON strings', () => {
    expect(summary.mon.funded).toBe('1');
    expect(summary.mon.funderSpent).toBe('1.000021');
    expect(summary.mon.hitsSpent).toBe('0.012');
    expect(summary.mon.gasUsedTotal).toBe('240000');
  });

  it('reports throughput and bucket pressure', () => {
    expect(summary.durationMs).toBe(60_000);
    expect(summary.confirmedPerSecond).toBeCloseTo(4 / 60);
    expect(summary.bucket).toEqual({ waits: 12, waitedMs: 800 });
  });

  it('handles an empty run without NaN', () => {
    const empty = aggregate([], { fundedWei: 0n, funderSpentWei: 0n, burnerSpentWei: 0n, durationMs: 0, bucketWaits: 0, bucketWaitedMs: 0 });
    expect(empty.latencyMs.p50).toBeNull();
    expect(empty.landing.onTimeRatio).toBe(0);
    expect(empty.confirmedPerSecond).toBe(0);
  });
});
