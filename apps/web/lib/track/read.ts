/**
 * Reads one finalized track from the contract: tokenURI (decoded), its session, and the
 * contributors with their hit counts. Plain `readContract` calls only: neither anvil nor
 * Monad testnet is guaranteed to expose multicall3.
 *
 * Review H6: the finalize overlay sends the whole room to /track/T from the laptop's IP.
 * A track is immutable after finalize (except tipPool), so views are memoised for 60 s per
 * (chain, address, tokenId) with one shared in-flight read, and `hitsOf` goes out four at
 * a time with 170 ms between chunks (the public RPC allows 25 eth_call per second).
 */
import { BaseError, ContractFunctionRevertedError, toFunctionSelector, type Address, type PublicClient } from 'viem';
import { blockbeatAbi } from '@blockbeat/shared';
import { decodeTokenUri, type TrackMetadata } from './decode';

export interface TrackContributor {
  address: Address;
  hits: bigint;
  /** hits / session hitCount, 0..1 (0 when the session has no hits). */
  share: number;
}

export interface TrackView {
  tokenId: bigint;
  sessionId: bigint;
  metadata: TrackMetadata;
  host: Address;
  hitCount: bigint;
  tipPool: bigint;
  /** Sorted by hits, descending. */
  contributors: TrackContributor[];
  /** W15: the 16 recorded step words stored with the token (`tokenPattern`), for playback. */
  pattern: bigint[];
}

/** The slice of viem's PublicClient this module needs (so tests can fake it). */
export type TrackReadClient = Pick<PublicClient, 'readContract'> & { chain?: { id: number } | undefined };

/** A per-key memo of in-flight or settled reads that forgets entries after a TTL. */
export interface TtlCache<T> {
  get(key: string): Promise<T> | null;
  set(key: string, value: Promise<T>): void;
  delete(key: string): void;
}

export type TrackCache = TtlCache<TrackView | null>;

export interface ReadTrackOptions {
  client: TrackReadClient;
  address: Address;
  tokenId: bigint;
  /** Defaults to the process-wide 60 s cache; null reads the chain every time. */
  cache?: TrackCache | null;
}

const NONEXISTENT_TOKEN = 'ERC721NonexistentToken';
/** Parallel `hitsOf` reads per batch and the pause between batches: 4 per 170 ms is ~23.5 calls/s at most, from one viewer, under the 25/s cap (W15 review: 150 ms was ~26.7/s). */
export const HITS_OF_CHUNK = 4;
export const HITS_OF_CHUNK_SPACING_MS = 170;
export const TRACK_CACHE_TTL_MS = 60_000;

export function createTtlCache<T>(ttlMs: number, now: () => number = () => Date.now()): TtlCache<T> {
  const entries = new Map<string, { value: Promise<T>; expiresAt: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value) {
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

export function createTrackCache(ttlMs: number = TRACK_CACHE_TTL_MS, now: () => number = () => Date.now()): TrackCache {
  return createTtlCache<TrackView | null>(ttlMs, now);
}

const sharedCache = createTrackCache();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function mapChunked<T, R>(items: readonly T[], size: number, spacingMs: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    if (i > 0) await sleep(spacingMs);
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}
/** Selector of ERC721NonexistentToken(uint256), matched when the ABI could not decode the revert. */
export const NONEXISTENT_TOKEN_SELECTOR = toFunctionSelector('ERC721NonexistentToken(uint256)');

/** tokenURI plus the OZ error so viem names the revert for an unminted token. */
const tokenUriAbi = blockbeatAbi;

function isNonexistentToken(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return false;
  return revert.data?.errorName === NONEXISTENT_TOKEN || revert.signature === NONEXISTENT_TOKEN_SELECTOR;
}

export async function readTrack(options: ReadTrackOptions): Promise<TrackView | null> {
  const cache = options.cache === undefined ? sharedCache : options.cache;
  if (!cache) return readTrackUncached(options);
  const key = `${options.client.chain?.id ?? 'unknown'}:${options.address.toLowerCase()}:${options.tokenId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = readTrackUncached(options).then((view) => {
    // A missing token may be minted a moment later: never remember null.
    if (view === null) cache.delete(key);
    return view;
  });
  // Only a successful view stays; a failed read must be retried by the next viewer.
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

async function readTrackUncached({ client, address, tokenId }: ReadTrackOptions): Promise<TrackView | null> {
  let uri: string;
  let sessionId: bigint;
  let words: readonly bigint[];
  try {
    // All three depend only on tokenId; one round trip instead of three.
    [uri, sessionId, words] = await Promise.all([
      client.readContract({ address, abi: tokenUriAbi, functionName: 'tokenURI', args: [tokenId] }),
      client.readContract({ address, abi: blockbeatAbi, functionName: 'tokenSession', args: [tokenId] }),
      client.readContract({ address, abi: blockbeatAbi, functionName: 'tokenPattern', args: [tokenId] }),
    ]);
  } catch (error) {
    if (isNonexistentToken(error)) return null;
    throw error;
  }
  const metadata = decodeTokenUri(uri);
  const [session, players] = await Promise.all([
    client.readContract({ address, abi: blockbeatAbi, functionName: 'getSession', args: [sessionId] }),
    client.readContract({ address, abi: blockbeatAbi, functionName: 'contributorsOf', args: [sessionId] }),
  ]);
  const hits = await mapChunked(players, HITS_OF_CHUNK, HITS_OF_CHUNK_SPACING_MS, (player) =>
    client.readContract({ address, abi: blockbeatAbi, functionName: 'hitsOf', args: [sessionId, player] }),
  );

  const hitCount = session.hitCount;
  const contributors: TrackContributor[] = players
    .map((player, i) => {
      const h = hits[i] ?? 0n;
      return { address: player, hits: h, share: hitCount === 0n ? 0 : Number(h) / Number(hitCount) };
    })
    .sort((a, b) => (a.hits === b.hits ? 0 : a.hits > b.hits ? -1 : 1));

  return { tokenId, sessionId, metadata, host: session.host, hitCount, tipPool: session.tipPool, contributors, pattern: [...words] };
}
