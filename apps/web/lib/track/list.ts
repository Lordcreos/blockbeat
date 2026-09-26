/**
 * W15: every minted track (the /tracks gallery) and the recent sessions (/host), read from
 * contract views only.
 *
 * Why a session scan and not `Finalized` logs: the public RPC refuses a 1000-block
 * `eth_getLogs` range and 100 blocks take ~300 ms, so a scan from the deploy block
 * (65,514,418) would need ~1,000 requests per 100k blocks and grow every 300 ms. Sessions are
 * few (one per round), and `sessionCount` + `getSession(id)` gives each session's
 * `finalized` flag and `tokenId` directly: N + 1 calls, then two per minted track
 * (`tokenURI` for the cover, `tokenPattern` for playback). Reads go out four at a time,
 * 170 ms apart (~23.5 calls/s; the public RPC allows 25 eth_call/s), and the list is memoised for 60 s per
 * (chain, address) with one shared in-flight read, like readTrack.
 */
import type { Address } from 'viem';
import { blockbeatAbi } from '@blockbeat/shared';
import { decodeTokenUri } from './decode';
import { HITS_OF_CHUNK, HITS_OF_CHUNK_SPACING_MS, createTtlCache, mapChunked, type TrackReadClient, type TtlCache } from './read';

export interface SessionSummary {
  sessionId: bigint;
  finalized: boolean;
  /** 0 until finalized. */
  tokenId: bigint;
  hitCount: bigint;
  tipPool: bigint;
}

export interface TrackSummary {
  tokenId: bigint;
  sessionId: bigint;
  name: string;
  /** `data:image/svg+xml;base64,…` from tokenURI, safe as an <img> src. */
  imageDataUri: string;
  contributors: number;
  hitCount: bigint;
  tipPool: bigint;
  pattern: bigint[];
}

/** The gallery looks at the newest sessions only; a hackathon has a handful. */
export const GALLERY_MAX_SESSIONS = 200;
export const LIST_CACHE_TTL_MS = 60_000;
/** Two reads per track (tokenURI + tokenPattern), so two tracks per chunk keeps four calls in flight. */
const TRACKS_PER_CHUNK = HITS_OF_CHUNK / 2;

export type ListCache = TtlCache<TrackSummary[]>;

export function createListCache(ttlMs: number = LIST_CACHE_TTL_MS, now: () => number = () => Date.now()): ListCache {
  return createTtlCache<TrackSummary[]>(ttlMs, now);
}

const sharedCache = createListCache();

interface ReadOptions {
  client: TrackReadClient;
  address: Address;
}

/** The newest `limit` sessions, newest first. */
export async function readRecentSessions({ client, address, limit }: ReadOptions & { limit: number }): Promise<SessionSummary[]> {
  const count = await client.readContract({ address, abi: blockbeatAbi, functionName: 'sessionCount' });
  const ids: bigint[] = [];
  for (let id = count; id >= 1n && ids.length < limit; id--) ids.push(id);
  return mapChunked(ids, HITS_OF_CHUNK, HITS_OF_CHUNK_SPACING_MS, async (sessionId) => {
    const s = await client.readContract({ address, abi: blockbeatAbi, functionName: 'getSession', args: [sessionId] });
    return { sessionId, finalized: s.finalized, tokenId: s.tokenId, hitCount: s.hitCount, tipPool: s.tipPool };
  });
}

function contributorsAttribute(attributes: { traitType: string; value: string | number }[]): number {
  const raw = attributes.find((a) => a.traitType === 'contributors')?.value;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function listTracksUncached({ client, address }: ReadOptions): Promise<TrackSummary[]> {
  const sessions = await readRecentSessions({ client, address, limit: GALLERY_MAX_SESSIONS });
  const minted = sessions.filter((s) => s.finalized && s.tokenId > 0n).sort((a, b) => (a.tokenId === b.tokenId ? 0 : a.tokenId > b.tokenId ? -1 : 1));
  return mapChunked(minted, TRACKS_PER_CHUNK, HITS_OF_CHUNK_SPACING_MS, async (s) => {
    const [uri, words] = await Promise.all([
      client.readContract({ address, abi: blockbeatAbi, functionName: 'tokenURI', args: [s.tokenId] }),
      client.readContract({ address, abi: blockbeatAbi, functionName: 'tokenPattern', args: [s.tokenId] }),
    ]);
    const metadata = decodeTokenUri(uri);
    return {
      tokenId: s.tokenId,
      sessionId: s.sessionId,
      name: metadata.name,
      imageDataUri: metadata.imageDataUri,
      contributors: contributorsAttribute(metadata.attributes),
      hitCount: s.hitCount,
      tipPool: s.tipPool,
      pattern: [...words],
    };
  });
}

export interface ListTracksOptions extends ReadOptions {
  /** Defaults to the process-wide 60 s cache; null reads the chain every time. */
  cache?: ListCache | null;
}

/** Every minted track among the newest GALLERY_MAX_SESSIONS sessions, newest token first. */
export function listTracks(options: ListTracksOptions): Promise<TrackSummary[]> {
  const cache = options.cache === undefined ? sharedCache : options.cache;
  if (!cache) return listTracksUncached(options);
  const key = `${options.client.chain?.id ?? 'unknown'}:${options.address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = listTracksUncached(options);
  cache.set(key, pending);
  // A failed read must be retried by the next viewer, never served from the memo.
  pending.catch(() => cache.delete(key));
  return pending;
}
