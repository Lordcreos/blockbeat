import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { ZERO_ADDRESS } from '@blockbeat/shared';
import type { TrackReadClient } from './read';
import { readTrackTips } from './tips';

const ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address;
const DJ = '0x2222222222222222222222222222222222222222' as Address;

function client(values: Record<string, unknown>) {
  const at: Array<[string, number]> = [];
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    at.push([functionName, Date.now()]);
    if (!(functionName in values)) throw new Error(`function ${functionName} not found on the contract`);
    return values[functionName];
  });
  return { client: { readContract, chain: { id: 10143 } } as unknown as TrackReadClient, at, readContract };
}

const W21A = { totalTipsOf: 50n, hostTipsOf: 10n, hostClaimableOf: 4n, humanHitCountOf: 7n, agent: DJ };

describe('readTrackTips (W21b)', () => {
  afterEach(() => vi.useRealTimers());

  it('reads the W21a tip views four then one, 170 ms apart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client: c, at } = client(W21A);
    const p = readTrackTips({ client: c, address: ADDRESS, sessionId: 9n, cache: null });
    await vi.advanceTimersByTimeAsync(170);
    expect(await p).toEqual({ totalWei: 50n, hostWei: 10n, hostClaimableWei: 4n, humanHitCount: 7n, agent: DJ });
    expect(at.map(([, t]) => t)).toEqual([0, 0, 0, 0, 170]);
  });

  it('answers null (pool only) on a contract without the views, and never caches that', async () => {
    const log = vi.fn();
    const { client: c, readContract } = client({});
    expect(await readTrackTips({ client: c, address: ADDRESS, sessionId: 9n, log })).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/pool only/));
    await readTrackTips({ client: c, address: ADDRESS, sessionId: 9n, log });
    expect(readContract.mock.calls.length).toBeGreaterThan(5);
  });

  it('reports a zero agent as no DJ and memoises per session', async () => {
    const { client: c, readContract } = client({ ...W21A, agent: ZERO_ADDRESS });
    const first = await readTrackTips({ client: c, address: ADDRESS, sessionId: 11n });
    expect(first?.agent).toBeNull();
    expect(await readTrackTips({ client: c, address: ADDRESS, sessionId: 11n })).toBe(first);
    expect(readContract).toHaveBeenCalledTimes(5);
  });
});
