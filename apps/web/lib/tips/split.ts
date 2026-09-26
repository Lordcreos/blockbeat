/**
 * W21b: the tip split as the contract (W21a) applies it, for the simulator and the track page,
 * on top of the shared helpers (packages/shared splitTip / playerShare). Pure. Per tip:
 * HOST_TIP_BPS to the host, the rest to the pool; with no human hits yet the host takes all.
 * At the end the pool is split among the human players pro rata by hits (floor, like the
 * contract's claim); the DJ agent keeps its notes and earns nothing.
 */
import type { Address } from 'viem';
import { playerShare, splitTip as sharedSplitTip } from '@blockbeat/shared';

export interface TipSplitAmounts {
  hostWei: bigint;
  poolWei: bigint;
}

export function splitTip(amountWei: bigint, humanHits: bigint): TipSplitAmounts {
  const { hostAmount, poolAmount } = sharedSplitTip(amountWei, humanHits);
  return { hostWei: hostAmount, poolWei: poolAmount };
}

export interface SplitContributor {
  address: Address;
  hits: bigint;
}

export interface SplitRow {
  address: Address;
  hits: bigint;
  isAgent: boolean;
  /** Share of the pool in percent (rounded), null for the DJ. */
  sharePct: number | null;
  earnedWei: bigint;
}

export interface TrackSplit {
  raisedWei: bigint;
  hostWei: bigint;
  poolWei: bigint;
  humanHits: bigint;
  /** Humans by hits (most first), then the DJ. */
  rows: SplitRow[];
}

export interface TrackSplitInput {
  hostWei: bigint;
  poolWei: bigint;
  contributors: readonly SplitContributor[];
  /** The DJ agent's address (the contract's `agent()`); null when there is none. */
  agent: Address | null;
}

export function trackSplit({ hostWei, poolWei, contributors, agent }: TrackSplitInput): TrackSplit {
  const dj = agent?.toLowerCase() ?? null;
  const isAgent = (a: Address): boolean => dj !== null && a.toLowerCase() === dj;
  const humanHits = contributors.reduce((sum, c) => (isAgent(c.address) ? sum : sum + c.hits), 0n);
  const rows: SplitRow[] = contributors.map((c) => {
    if (isAgent(c.address)) return { address: c.address, hits: c.hits, isAgent: true, sharePct: null, earnedWei: 0n };
    const earnedWei = playerShare(poolWei, c.hits, humanHits);
    const sharePct = humanHits === 0n ? 0 : Math.round((Number(c.hits) / Number(humanHits)) * 100);
    return { address: c.address, hits: c.hits, isAgent: false, sharePct, earnedWei };
  });
  rows.sort((a, b) => {
    if (a.isAgent !== b.isAgent) return a.isAgent ? 1 : -1;
    return a.hits === b.hits ? 0 : a.hits > b.hits ? -1 : 1;
  });
  return { raisedWei: hostWei + poolWei, hostWei, poolWei, humanHits, rows };
}
