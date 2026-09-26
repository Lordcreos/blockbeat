/**
 * Per-hit records and their aggregation into the numbers the report shows: latency
 * percentiles, RPC error histogram, rate-limit hits, landing accuracy and MON spent.
 */
import { BaseError, HttpRequestError, RpcRequestError, TimeoutError, formatEther } from 'viem';
import { classifyLanding } from './stepPrediction';

export type HitStatus = 'confirmed' | 'reverted' | 'send-failed' | 'timeout';

export interface HitRecord {
  wallet: number;
  index: number;
  sentAt: number;
  receiptAt?: number;
  blockNumber?: bigint;
  txHash?: `0x${string}`;
  intendedStep: number;
  intendedBlock?: bigint;
  actualStep?: number;
  latencyMs?: number;
  status: HitStatus;
  errorCode?: string;
  errorMessage?: string;
  rateLimited?: boolean;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
}

export interface ErrorClass {
  code: string;
  rateLimited: boolean;
  message: string;
}

const RATE_LIMIT_RE = /rate ?limit|too many requests|429|throttl/i;

export function classifyRpcError(err: unknown): ErrorClass {
  if (err instanceof HttpRequestError) {
    const status = err.status;
    const code = status === undefined ? 'HTTP' : `HTTP_${status}`;
    return { code, rateLimited: status === 429 || RATE_LIMIT_RE.test(err.message), message: err.details || err.shortMessage };
  }
  if (err instanceof RpcRequestError) {
    return { code: `RPC_${err.code}`, rateLimited: RATE_LIMIT_RE.test(err.message), message: err.details || err.shortMessage };
  }
  if (err instanceof TimeoutError) {
    return { code: 'TIMEOUT', rateLimited: false, message: err.shortMessage };
  }
  if (err instanceof BaseError) {
    // viem wraps transport errors; look for a status or code deeper in the chain.
    const inner = err.walk((e) => e instanceof HttpRequestError || e instanceof RpcRequestError || e instanceof TimeoutError);
    if (inner && inner !== err) return classifyRpcError(inner);
    return { code: err.name, rateLimited: RATE_LIMIT_RE.test(err.message), message: err.shortMessage };
  }
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') {
      return { code: `HTTP_${status}`, rateLimited: status === 429 || RATE_LIMIT_RE.test(err.message), message: err.message };
    }
    return { code: err.name || 'Error', rateLimited: RATE_LIMIT_RE.test(err.message), message: err.message };
  }
  return { code: 'UNKNOWN', rateLimited: false, message: String(err) };
}

/** Nearest-rank percentile; null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export interface Money {
  fundedWei: bigint;
  funderSpentWei: bigint;
  burnerSpentWei: bigint;
}

export interface AggregateInput extends Money {
  durationMs: number;
  bucketWaits: number;
  bucketWaitedMs: number;
}

export interface ErrorRow {
  code: string;
  count: number;
  rateLimited: boolean;
  sample: string;
}

export interface Summary {
  hits: { total: number; confirmed: number; reverted: number; sendFailed: number; timedOut: number };
  latencyMs: { p50: number | null; p95: number | null; p99: number | null; min: number | null; max: number | null; mean: number | null };
  errors: ErrorRow[];
  rateLimitHits: number;
  landing: { onTime: number; oneLate: number; late: number; early: number; onTimeRatio: number; withinOneStepRatio: number };
  mon: { funded: string; funderSpent: string; hitsSpent: string; gasUsedTotal: string };
  durationMs: number;
  confirmedPerSecond: number;
  bucket: { waits: number; waitedMs: number };
}

export function aggregate(records: readonly HitRecord[], input: AggregateInput): Summary {
  const confirmed = records.filter((r) => r.status === 'confirmed');
  const latencies = confirmed.flatMap((r) => (typeof r.latencyMs === 'number' ? [r.latencyMs] : []));

  const errorMap = new Map<string, ErrorRow>();
  let rateLimitHits = 0;
  for (const r of records) {
    if (!r.errorCode) continue;
    const row = errorMap.get(r.errorCode) ?? { code: r.errorCode, count: 0, rateLimited: r.rateLimited === true, sample: r.errorMessage ?? '' };
    row.count += 1;
    errorMap.set(r.errorCode, row);
    if (r.rateLimited) rateLimitHits += 1;
  }

  const landing = { onTime: 0, oneLate: 0, late: 0, early: 0 };
  for (const r of confirmed) {
    if (typeof r.actualStep !== 'number') continue;
    const cls = classifyLanding(r.intendedStep, r.actualStep);
    if (cls === 'on-time') landing.onTime += 1;
    else if (cls === 'one-late') landing.oneLate += 1;
    else if (cls === 'late') landing.late += 1;
    else landing.early += 1;
  }
  const landed = landing.onTime + landing.oneLate + landing.late + landing.early;

  const gasUsedTotal = confirmed.reduce((acc, r) => acc + (r.gasUsed ?? 0n), 0n);
  const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;

  return {
    hits: {
      total: records.length,
      confirmed: confirmed.length,
      reverted: records.filter((r) => r.status === 'reverted').length,
      sendFailed: records.filter((r) => r.status === 'send-failed').length,
      timedOut: records.filter((r) => r.status === 'timeout').length,
    },
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      min: latencies.length ? Math.min(...latencies) : null,
      max: latencies.length ? Math.max(...latencies) : null,
      mean,
    },
    errors: [...errorMap.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    rateLimitHits,
    landing: {
      ...landing,
      onTimeRatio: landed ? landing.onTime / landed : 0,
      withinOneStepRatio: landed ? (landing.onTime + landing.oneLate) / landed : 0,
    },
    mon: {
      funded: formatEther(input.fundedWei),
      funderSpent: formatEther(input.funderSpentWei),
      hitsSpent: formatEther(input.burnerSpentWei),
      gasUsedTotal: gasUsedTotal.toString(),
    },
    durationMs: input.durationMs,
    confirmedPerSecond: input.durationMs > 0 ? confirmed.length / (input.durationMs / 1000) : 0,
    bucket: { waits: input.bucketWaits, waitedMs: input.bucketWaitedMs },
  };
}
