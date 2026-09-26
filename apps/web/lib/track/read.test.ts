import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, type Address } from 'viem';
import { HITS_OF_CHUNK, HITS_OF_CHUNK_SPACING_MS, TRACK_CACHE_TTL_MS, createTrackCache, readTrack, type TrackReadClient } from './read';

const ADDRESS: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const HOST: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const A: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const B: Address = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const URI = `data:application/json;base64,${b64(
  JSON.stringify({
    name: 'Blockbeat Track #7',
    description: 'd',
    image: `data:image/svg+xml;base64,${b64(SVG)}`,
    attributes: [{ trait_type: 'hits', value: 3 }],
  }),
)}`;

const PATTERN: bigint[] = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 1n : 0n));

type Call = { functionName: string; args?: readonly unknown[] };

function fakeClient(handler: (call: Call) => unknown): TrackReadClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    readContract: vi.fn(async (params: unknown) => {
      const call = params as Call;
      calls.push(call);
      return handler(call);
    }) as unknown as TrackReadClient['readContract'],
  };
}

function nonexistentTokenError(): Error {
  const revert = new ContractFunctionRevertedError({
    abi: [{ type: 'error', name: 'ERC721NonexistentToken', inputs: [{ name: 'tokenId', type: 'uint256' }] }],
    functionName: 'tokenURI',
    data: '0x7e27328900000000000000000000000000000000000000000000000000000000000000007',
  });
  return new ContractFunctionExecutionError(revert, { abi: [], functionName: 'tokenURI', args: [7n] });
}

function sessionClient(players: Address[], hitsFor: (player: Address) => bigint = () => 1n, opts: { onHitsOf?: () => void } = {}) {
  return fakeClient(({ functionName, args }) => {
    switch (functionName) {
      case 'tokenURI':
        return URI;
      case 'tokenSession':
        return 4n;
      case 'tokenPattern':
        return PATTERN;
      case 'getSession':
        return { startBlock: 10n, host: HOST, finalized: true, hitCount: BigInt(players.length), tokenId: 7n, parentSessionId: 0n, tipPool: 0n };
      case 'contributorsOf':
        return players;
      case 'hitsOf':
        opts.onHitsOf?.();
        return hitsFor(args?.[1] as Address);
      default:
        throw new Error(`unexpected ${functionName}`);
    }
  });
}

const player = (i: number): Address => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address;

describe('readTrack rate budget and memo (review H6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads hitsOf four at a time with 170 ms between chunks', async () => {
    vi.useFakeTimers();
    expect(HITS_OF_CHUNK).toBe(4);
    expect(HITS_OF_CHUNK_SPACING_MS).toBe(170);
    const players = Array.from({ length: 9 }, (_, i) => player(i));
    const at: number[] = [];
    const client = sessionClient(players, () => 1n, { onHitsOf: () => at.push(Date.now()) });
    vi.setSystemTime(0);
    const p = readTrack({ client, address: ADDRESS, tokenId: 7n, cache: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(at).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(169);
    expect(at).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(170);
    expect(at).toHaveLength(9);
    const view = await p;
    expect(view?.contributors).toHaveLength(9);
    expect(at.filter((t) => t === 0)).toHaveLength(4);
    expect(at.filter((t) => t === 170)).toHaveLength(4);
    expect(at.filter((t) => t === 340)).toHaveLength(1);
  });

  it('memoises a track for 60 s per (chain, address, tokenId) and shares one in-flight read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    expect(TRACK_CACHE_TTL_MS).toBe(60_000);
    const cache = createTrackCache();
    const client = sessionClient([A, B]);
    const [x, y] = await Promise.all([readTrack({ client, address: ADDRESS, tokenId: 7n, cache }), readTrack({ client, address: ADDRESS, tokenId: 7n, cache })]);
    expect(x).toBe(y);
    const reads = client.calls.length;
    expect(reads).toBeGreaterThan(0);
    expect(await readTrack({ client, address: ADDRESS, tokenId: 7n, cache })).toBe(x);
    expect(client.calls).toHaveLength(reads);
    // Another token is its own entry.
    await readTrack({ client, address: ADDRESS, tokenId: 8n, cache });
    expect(client.calls.length).toBeGreaterThan(reads);
    const afterSecond = client.calls.length;
    vi.setSystemTime(1_000 + 60_000);
    await readTrack({ client, address: ADDRESS, tokenId: 7n, cache });
    expect(client.calls.length).toBeGreaterThan(afterSecond);
  });

  it('does not memoise a missing token or a failed read', async () => {
    const cache = createTrackCache();
    let exists = false;
    const client = fakeClient(({ functionName }) => {
      if (!exists) throw nonexistentTokenError();
      switch (functionName) {
        case 'tokenURI':
          return URI;
        case 'tokenSession':
          return 4n;
        case 'tokenPattern':
          return PATTERN;
        case 'getSession':
          return { startBlock: 10n, host: HOST, finalized: true, hitCount: 0n, tokenId: 7n, parentSessionId: 0n, tipPool: 0n };
        case 'contributorsOf':
          return [];
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    });
    expect(await readTrack({ client, address: ADDRESS, tokenId: 7n, cache })).toBeNull();
    exists = true;
    expect(await readTrack({ client, address: ADDRESS, tokenId: 7n, cache })).not.toBeNull();
    const failing = fakeClient(() => {
      throw new BaseError('rpc down');
    });
    await expect(readTrack({ client: failing, address: ADDRESS, tokenId: 9n, cache })).rejects.toThrow(/rpc down/);
    // The failure is not sticky: the next read goes to the chain again.
    await expect(readTrack({ client: failing, address: ADDRESS, tokenId: 9n, cache })).rejects.toThrow(/rpc down/);
    expect(failing.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('readTrack', () => {
  it('reads tokenURI, session, contributors and hits and sorts by hits', async () => {
    const client = fakeClient(({ functionName, args }) => {
      switch (functionName) {
        case 'tokenURI':
          return URI;
        case 'tokenSession':
          return 4n;
        case 'tokenPattern':
          return PATTERN;
        case 'getSession':
          return { startBlock: 10n, host: HOST, finalized: true, hitCount: 3n, tokenId: 7n, parentSessionId: 0n, tipPool: 5_000_000_000_000_000n };
        case 'contributorsOf':
          return [A, B];
        case 'hitsOf':
          return args?.[1] === A ? 1n : 2n;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    });
    const view = await readTrack({ client, address: ADDRESS, tokenId: 7n, cache: null });
    expect(view).not.toBeNull();
    expect(view?.tokenId).toBe(7n);
    expect(view?.sessionId).toBe(4n);
    expect(view?.host).toBe(HOST);
    expect(view?.hitCount).toBe(3n);
    expect(view?.tipPool).toBe(5_000_000_000_000_000n);
    expect(view?.metadata.name).toBe('Blockbeat Track #7');
    expect(view?.metadata.imageSvg).toBe(SVG);
    // W15: the recorded pattern of the token, for playback on /track.
    expect(view?.pattern).toEqual(PATTERN);
    expect(view?.contributors).toEqual([
      { address: B, hits: 2n, share: 2 / 3 },
      { address: A, hits: 1n, share: 1 / 3 },
    ]);
    expect(client.calls.every((c) => 'address' in c)).toBe(true);
  });

  it('returns null when the token does not exist', async () => {
    const client = fakeClient(({ functionName }) => {
      if (functionName === 'tokenURI') throw nonexistentTokenError();
      throw new Error('should not be called');
    });
    expect(await readTrack({ client, address: ADDRESS, tokenId: 7n, cache: null })).toBeNull();
  });

  it('returns null when the revert is undecoded but carries the ERC721NonexistentToken selector', async () => {
    const revert = new ContractFunctionRevertedError({ abi: [], functionName: 'tokenURI', data: '0x7e27328900000000000000000000000000000000000000000000000000000000000000007' });
    expect(revert.data).toBeUndefined();
    const client = fakeClient(({ functionName }) => {
      if (functionName === 'tokenURI') throw new ContractFunctionExecutionError(revert, { abi: [], functionName: 'tokenURI', args: [7n] });
      throw new Error('should not be called');
    });
    expect(await readTrack({ client, address: ADDRESS, tokenId: 7n, cache: null })).toBeNull();
  });

  it('rethrows a different custom error', async () => {
    const revert = new ContractFunctionRevertedError({ abi: [], functionName: 'tokenURI', data: '0xdeadbeef' });
    const client = fakeClient(() => {
      throw new ContractFunctionExecutionError(revert, { abi: [], functionName: 'tokenURI', args: [7n] });
    });
    await expect(readTrack({ client, address: ADDRESS, tokenId: 7n, cache: null })).rejects.toThrow(ContractFunctionExecutionError);
  });

  it('rethrows any other error', async () => {
    const client = fakeClient(() => {
      throw new BaseError('rpc down');
    });
    await expect(readTrack({ client, address: ADDRESS, tokenId: 7n, cache: null })).rejects.toThrow(/rpc down/);
  });

  it('gives every contributor a zero share when the session has no hits', async () => {
    const client = fakeClient(({ functionName }) => {
      switch (functionName) {
        case 'tokenURI':
          return URI;
        case 'tokenSession':
          return 1n;
        case 'tokenPattern':
          return PATTERN;
        case 'getSession':
          return { startBlock: 1n, host: HOST, finalized: true, hitCount: 0n, tokenId: 1n, parentSessionId: 0n, tipPool: 0n };
        case 'contributorsOf':
          return [];
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    });
    const view = await readTrack({ client, address: ADDRESS, tokenId: 1n, cache: null });
    expect(view?.contributors).toEqual([]);
  });
});
