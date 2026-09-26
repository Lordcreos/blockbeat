/**
 * W21b: the tip accounting of a finalized track's session (W21a views): totalTipsOf,
 * hostTipsOf, hostClaimableOf, humanHitCountOf and the contract's DJ, `agent()`. Five eth_calls
 * read four then one, HITS_OF_CHUNK_SPACING_MS apart, like the hitsOf reads (the public RPC
 * allows 25 eth_call per second), and memoised for 15 s per (chain, address, session): claims
 * move the host figure, so this cache is shorter than the track's. A contract without these
 * views (the pre-split deploy) answers null: the page then shows the pool only.
 */
import type { Address } from 'viem';
import { ZERO_ADDRESS, blockbeatAbi } from '@blockbeat/shared';
import { HITS_OF_CHUNK_SPACING_MS, createTtlCache, type TrackReadClient, type TtlCache } from './read';

export interface TrackTipTotals {
  totalWei: bigint;
  hostWei: bigint;
  hostClaimableWei: bigint;
  humanHitCount: bigint;
  /** The contract's resident DJ; null when it reports the zero address. */
  agent: Address | null;
}

export const TRACK_TIPS_TTL_MS = 15_000;
const sharedCache = createTtlCache<TrackTipTotals | null>(TRACK_TIPS_TTL_MS);

export interface ReadTrackTipsOptions {
  client: TrackReadClient;
  address: Address;
  sessionId: bigint;
  cache?: TtlCache<TrackTipTotals | null> | null;
  log?: (message: string) => void;
}

async function readUncached({ client, address, sessionId, log = (m: string) => console.warn(m) }: ReadTrackTipsOptions): Promise<TrackTipTotals | null> {
  let totalWei: bigint, hostWei: bigint, hostClaimableWei: bigint, humanHitCount: bigint, agent: Address;
  try {
    // Four, then one after the spacing: typed reads (review), same pacing as hitsOf.
    [totalWei, hostWei, hostClaimableWei, humanHitCount] = await Promise.all([
      client.readContract({ address, abi: blockbeatAbi, functionName: 'totalTipsOf', args: [sessionId] }),
      client.readContract({ address, abi: blockbeatAbi, functionName: 'hostTipsOf', args: [sessionId] }),
      client.readContract({ address, abi: blockbeatAbi, functionName: 'hostClaimableOf', args: [sessionId] }),
      client.readContract({ address, abi: blockbeatAbi, functionName: 'humanHitCountOf', args: [sessionId] }),
    ]);
    await new Promise((r) => setTimeout(r, HITS_OF_CHUNK_SPACING_MS));
    agent = await client.readContract({ address, abi: blockbeatAbi, functionName: 'agent' });
  } catch (error) {
    log(`track tips: session ${sessionId} tip views unreadable (${error instanceof Error ? error.message : String(error)}); showing the pool only`);
    return null;
  }
  return { totalWei, hostWei, hostClaimableWei, humanHitCount, agent: agent === ZERO_ADDRESS ? null : agent };
}

export function readTrackTips(options: ReadTrackTipsOptions): Promise<TrackTipTotals | null> {
  const cache = options.cache === undefined ? sharedCache : options.cache;
  if (!cache) return readUncached(options);
  const key = `${options.client.chain?.id ?? 'unknown'}:${options.address.toLowerCase()}:${options.sessionId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = readUncached(options).then((totals) => {
    if (totals === null) cache.delete(key);
    return totals;
  });
  cache.set(key, pending);
  return pending;
}
