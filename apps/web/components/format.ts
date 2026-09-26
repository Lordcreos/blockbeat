/**
 * Pure formatting helpers for the HUD and pages. Kept free of React so they
 * can be unit tested (see app/__tests__/format.test.ts).
 */

/** Blocks per beat. Steps are 8th notes: 16 steps = 2 bars at 300 ms blocks = 100 BPM. */
export const BLOCKS_PER_BEAT = 2;

/** Tempo implied by the measured block cadence, rounded to a whole BPM. */
export function measuredBpm(measuredBlockMs: number): number {
  if (!(measuredBlockMs > 0)) return 0;
  return Math.round(60000 / (measuredBlockMs * BLOCKS_PER_BEAT));
}

const intFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatInt(n: number | bigint): string {
  return intFormatter.format(n);
}

export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

/** Left-pad with spaces to `width` characters (never truncates). */
export function padValue(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

/** Human-readable URL for the stage: no protocol, no trailing slash. */
export function shortUrl(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
