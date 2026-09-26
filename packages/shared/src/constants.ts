/** Sequencer geometry. Must match Blockbeat.sol constants. */
export const STEPS = 16 as const;
export const TRACKS = 8 as const;
export const NOTES_PER_TRACK = 32 as const;

/**
 * Tip split (W21a). Must match Blockbeat.sol HOST_TIP_BPS / BPS_DENOMINATOR: every tip pays
 * 20 % to the session host and 80 % to the players' pool (`Session.tipPool`), which human
 * players claim pro rata by hits after finalize. The resident DJ agent takes no tips.
 */
export const HOST_TIP_BPS = 2000n;
export const BPS_DENOMINATOR = 10_000n;

/** Monad block cadence and finality, in milliseconds. */
export const BLOCK_MS = 300 as const;
export const FINALITY_MS = 600 as const;
export const BAR_MS = BLOCK_MS * STEPS; // 4800

/**
 * Fixed gas limits for hot-path writes (never call eth_estimateGas in the audience flow).
 * Monad charges the gas LIMIT, not the gas used (docs: "the gas limit is what is charged"),
 * so limits are tiered to the measured cost. Measured on Monad testnet (W11,
 * docs/evidence/w11-testnet/04-gas-probe.txt; Monad reprices cold state access, anvil said
 * 140,091 / 61,538): the first hit of an empty session 169,565, a new player's first hit
 * 117,115, later hits 77,788. The old 160k/80k tiers ran first hits out of gas on testnet.
 */
export const HIT_GAS_LIMIT_FIRST = 200_000n;
export const HIT_GAS_LIMIT = 100_000n;
/**
 * tip (W21a split): one packed session-slot write (hostTips) plus the players' pool word and
 * two events. Anvil 55,540 for a session's first tip, 38,440 after; Monad reprices cold
 * access (+20-30 % on hits in W11), so 120k keeps headroom. 90k was sized for the pre-split tip.
 */
export const TIP_GAS_LIMIT = 120_000n;
/** claim (player, after finalize): anvil 61,890 incl. the value transfer; headroom for Monad. */
export const CLAIM_GAS_LIMIT = 150_000n;
/** claimHost (host share of tips, any time): anvil 57,153 first, 40,053 after; headroom for Monad. */
export const HOST_CLAIM_GAS_LIMIT = 150_000n;
/** startSession: one struct write, a counter and an event (~110k measured); headroom for anvil. */
export const START_SESSION_GAS_LIMIT = 250_000n;
/** finalize: copies 16 pattern words, mints, two events; 533k measured worst case (review L10: 3M cost 0.3 MON per call). */
export const FINALIZE_GAS_LIMIT = 900_000n;

/**
 * Fixed EIP-1559 fees for the hit path (review H7). Monad testnet's base fee is a flat
 * 100 gwei, so 150 gwei max with a 2 gwei tip always clears; passing both means viem skips
 * eth_getBlock and eth_maxPriorityFeePerGas before every send (two round trips on mobile).
 */
export const HIT_MAX_FEE_PER_GAS = 150_000_000_000n;
export const HIT_MAX_PRIORITY_FEE_PER_GAS = 2_000_000_000n;
/**
 * Monad testnet's flat base fee (100 gwei). What a transaction is actually charged per unit
 * of its gas LIMIT; used for balance-to-notes estimates on the phone (W12).
 */
export const MONAD_BASE_FEE_WEI = 100_000_000_000n;

/**
 * Drip defaults for burner wallets. At the 100 gwei minimum base fee a first hit costs
 * 0.02 MON and later hits 0.01 MON, so 0.3 MON funds roughly 28 hits per player.
 */
export const DRIP_AMOUNT_MON = '0.3';
export const HITS_PER_DRIP_ESTIMATE = 28;

export type TrackId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface TrackMeta {
  id: TrackId;
  key: 'kick' | 'snare' | 'hat' | 'clap' | 'bass' | 'lead' | 'pad' | 'fx';
  label: string;
  /** CSS colour token, defined in apps/web/styles/tokens.css. */
  colour: string;
}

export const TRACK_META: readonly TrackMeta[] = [
  { id: 0, key: 'kick', label: 'Kick', colour: 'var(--track-kick)' },
  { id: 1, key: 'snare', label: 'Snare', colour: 'var(--track-snare)' },
  { id: 2, key: 'hat', label: 'Hat', colour: 'var(--track-hat)' },
  { id: 3, key: 'clap', label: 'Clap', colour: 'var(--track-clap)' },
  { id: 4, key: 'bass', label: 'Bass', colour: 'var(--track-bass)' },
  { id: 5, key: 'lead', label: 'Lead', colour: 'var(--track-lead)' },
  { id: 6, key: 'pad', label: 'Pad', colour: 'var(--track-pad)' },
  { id: 7, key: 'fx', label: 'FX', colour: 'var(--track-fx)' },
] as const;

export function isTrackId(n: number): n is TrackId {
  return Number.isInteger(n) && n >= 0 && n < TRACKS;
}

export function isNote(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n < NOTES_PER_TRACK;
}

/**
 * Monad reserve balance (docs.monad.xyz/developer-essentials/reserve-balance). A transaction
 * that moves value and leaves its sender below 10 MON reverts (gas is still charged) unless
 * it is an "emptying" transaction: the sender sent no other transaction, of any kind, in the
 * past RESERVE_WINDOW_BLOCKS blocks. Zero-value calls (hit, startSession, finalize) never
 * revert for this. Seen on testnet by W11: 5 back-to-back transfers from a 4.4 MON wallet,
 * 1 landed and 4 reverted.
 */
export const MONAD_RESERVE_BALANCE_WEI = 10_000_000_000_000_000_000n;
export const RESERVE_WINDOW_BLOCKS = 3 as const;
/**
 * Heads a sender below the reserve waits after its previous transaction's send head before
 * sending the next value transfer: inclusion trails the send head by up to 2 blocks, and the
 * next transaction must land more than RESERVE_WINDOW_BLOCKS blocks after it.
 */
export const RESERVE_PACING_BLOCKS = RESERVE_WINDOW_BLOCKS + 2;

/** True when sending `amountWei` of value would leave a `balanceWei` sender below the reserve. */
export function isBelowReserve(balanceWei: bigint, amountWei: bigint): boolean {
  return balanceWei - amountWei < MONAD_RESERVE_BALANCE_WEI;
}
