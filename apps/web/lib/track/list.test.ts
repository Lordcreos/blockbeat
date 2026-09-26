import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { GALLERY_MAX_SESSIONS, LIST_CACHE_TTL_MS, createListCache, listTracks, readRecentSessions } from './list';
import type { TrackReadClient } from './read';

const ADDRESS: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const HOST: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const uri = (tokenId: bigint, contributors: number): string =>
  `data:application/json;base64,${b64(
    JSON.stringify({
      name: `Blockbeat Track #${tokenId}`,
      description: 'd',
      image: `data:image/svg+xml;base64,${b64(SVG)}`,
      attributes: [
        { trait_type: 'hits', value: 9 },
        { trait_type: 'contributors', value: contributors },
      ],
    }),
  )}`;
const patternOf = (tokenId: bigint): bigint[] => Array.from({ length: 16 }, (_, i) => (i === 0 ? tokenId : 0n));

type Call = { functionName: string; args?: readonly unknown[] };

/** Sessions 1..count; `minted` maps session id → token id. */
function chain(count: number, minted: Record<string, bigint>, opts: { onCall?: (c: Call) => void } = {}) {
  const calls: Call[] = [];
  const client: TrackReadClient = {
    readContract: vi.fn(async (params: unknown) => {
      const call = params as Call;
      calls.push(call);
      opts.onCall?.(call);
      const arg = call.args?.[0] as bigint | undefined;
      switch (call.functionName) {
        case 'sessionCount':
          return BigInt(count);
        case 'getSession': {
          const tokenId = minted[String(arg)] ?? 0n;
          return { startBlock: 100n * (arg ?? 0n), host: HOST, finalized: tokenId > 0n, hitCount: 3n * (arg ?? 0n), tokenId, parentSessionId: 0n, tipPool: tokenId * 1000n };
        }
        case 'tokenURI':
          return uri(arg ?? 0n, Number(arg ?? 0n) + 1);
        case 'tokenPattern':
          return patternOf(arg ?? 0n);
        default:
          throw new Error(`unexpected ${call.functionName}`);
      }
    }) as unknown as TrackReadClient['readContract'],
  };
  return { client, calls };
}

describe('readRecentSessions', () => {
  afterEach(() => vi.useRealTimers());

  it('reads sessionCount then the newest sessions first, with their state', async () => {
    const { client } = chain(5, { '2': 1n, '4': 2n });
    const sessions = await readRecentSessions({ client, address: ADDRESS, limit: 3 });
    expect(sessions.map((s) => s.sessionId)).toEqual([5n, 4n, 3n]);
    expect(sessions[1]).toMatchObject({ sessionId: 4n, finalized: true, tokenId: 2n, hitCount: 12n });
    expect(sessions[0]).toMatchObject({ finalized: false, tokenId: 0n });
  });

  it('returns nothing when no session exists', async () => {
    const { client, calls } = chain(0, {});
    expect(await readRecentSessions({ client, address: ADDRESS, limit: 8 })).toEqual([]);
    expect(calls.map((c) => c.functionName)).toEqual(['sessionCount']);
  });

  it('spaces getSession reads: four at a time, 170 ms apart (public RPC: 25 eth_call/s)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const at: number[] = [];
    const { client } = chain(9, {}, { onCall: (c) => void (c.functionName === 'getSession' && at.push(Date.now())) });
    const p = readRecentSessions({ client, address: ADDRESS, limit: 9 });
    await vi.advanceTimersByTimeAsync(0);
    expect(at).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(169);
    expect(at).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1 + 170);
    expect(at).toHaveLength(9);
    await p;
  });
});

describe('listTracks', () => {
  afterEach(() => vi.useRealTimers());

  it('lists every minted track, newest token first, with cover, contributors, hits, tip pool and pattern', async () => {
    vi.useFakeTimers();
    const { client } = chain(6, { '2': 1n, '3': 2n, '5': 3n });
    const p = listTracks({ client, address: ADDRESS, cache: null });
    await vi.runAllTimersAsync();
    const tracks = await p;
    expect(tracks.map((t) => t.tokenId)).toEqual([3n, 2n, 1n]);
    expect(tracks[0]).toMatchObject({
      tokenId: 3n,
      sessionId: 5n,
      name: 'Blockbeat Track #3',
      contributors: 4,
      hitCount: 15n,
      tipPool: 3000n,
      imageDataUri: `data:image/svg+xml;base64,${b64(SVG)}`,
    });
    expect(tracks[0]?.pattern).toEqual(patternOf(3n));
  });

  it('is empty when nothing was minted, without reading any token', async () => {
    const { client, calls } = chain(3, {});
    expect(await listTracks({ client, address: ADDRESS, cache: null })).toEqual([]);
    expect(calls.some((c) => c.functionName === 'tokenURI')).toBe(false);
  });

  it(`scans at most the newest ${GALLERY_MAX_SESSIONS} sessions`, async () => {
    vi.useFakeTimers();
    const { client, calls } = chain(GALLERY_MAX_SESSIONS + 50, {});
    const p = listTracks({ client, address: ADDRESS, cache: null });
    await vi.runAllTimersAsync();
    await p;
    const ids = calls.filter((c) => c.functionName === 'getSession').map((c) => c.args?.[0] as bigint);
    expect(ids).toHaveLength(GALLERY_MAX_SESSIONS);
    expect(ids[0]).toBe(BigInt(GALLERY_MAX_SESSIONS + 50));
    expect(ids.at(-1)).toBe(51n);
  });

  it('memoises the list for 60 s per (chain, address) and shares one in-flight read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    expect(LIST_CACHE_TTL_MS).toBe(60_000);
    const cache = createListCache();
    const { client, calls } = chain(2, { '1': 1n });
    const both = Promise.all([listTracks({ client, address: ADDRESS, cache }), listTracks({ client, address: ADDRESS, cache })]);
    await vi.runAllTimersAsync();
    const [a, b] = await both;
    expect(a).toBe(b);
    const n = calls.length;
    expect(await listTracks({ client, address: ADDRESS, cache })).toBe(a);
    expect(calls).toHaveLength(n);
    vi.setSystemTime(LIST_CACHE_TTL_MS);
    const again = listTracks({ client, address: ADDRESS, cache });
    await vi.runAllTimersAsync();
    await again;
    expect(calls.length).toBeGreaterThan(n);
  });

  it('does not memoise a failed read', async () => {
    const cache = createListCache();
    let fail = true;
    const ok = chain(1, { '1': 1n });
    const client: TrackReadClient = {
      readContract: vi.fn(async (params: unknown) => {
        if (fail) throw new Error('rpc down');
        return (ok.client.readContract as unknown as (p: unknown) => Promise<unknown>)(params);
      }) as unknown as TrackReadClient['readContract'],
    };
    await expect(listTracks({ client, address: ADDRESS, cache })).rejects.toThrow(/rpc down/);
    fail = false;
    expect(await listTracks({ client, address: ADDRESS, cache })).toHaveLength(1);
  });
});
