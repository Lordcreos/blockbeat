/**
 * Rolling average of confirmation latencies reported by hit senders on this device.
 * Shared between the hit sender (writer) and the event feed (reader for the HUD).
 */
export interface LatencyTracker {
  record(ms: number): void;
  average(): number | null;
  subscribe(cb: (average: number | null) => void): () => void;
}

export function createLatencyTracker(windowSize = 32): LatencyTracker {
  const samples: number[] = [];
  const listeners = new Set<(average: number | null) => void>();

  function average(): number | null {
    if (samples.length === 0) return null;
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  return {
    record(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`latency sample must be a non-negative number, got ${String(ms)}`);
      samples.push(ms);
      while (samples.length > windowSize) samples.shift();
      const avg = average();
      for (const cb of listeners) cb(avg);
    },
    average,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Process-wide tracker used by the default hit sender and event feed wiring. */
export const sharedLatency: LatencyTracker = createLatencyTracker();
