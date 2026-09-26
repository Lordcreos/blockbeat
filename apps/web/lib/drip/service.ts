/**
 * Drip service: funds a burner once, rate-limits per IP, assigns tracks round robin.
 * All state is in memory (SDD: no database). The sender is injected so tests never
 * touch a chain and the route never sees the private key.
 *
 * W12 top-ups: `{ topUp: true }` sends the same amount again to an address this server
 * funded before, only while its balance is below TOP_UP_BELOW_WEI (0.03 MON), at most
 * MAX_TOP_UPS_PER_ADDRESS times per server lifetime, through the same caps and pacing.
 *
 * W19 room cap: at most `maxPlayersPerSession` distinct addresses get a first drip per session
 * (DRIP_MAX_PLAYERS_PER_SESSION, default 20, 0 = off); the next one gets 409 ROOM_FULL and the
 * phone says the room is full. A seat is taken while the send is in flight and given back when
 * it fails or reverts. Top-ups never take a seat. Requests without a session share one room.
 */
import { getAddress, isAddress, type Address, type Hash } from 'viem';
import { TRACKS, type TrackId } from '@blockbeat/shared';
import { MAX_TOP_UPS_PER_ADDRESS, TOP_UP_BELOW_WEI, formatMon } from '../funding';
import type { DripResult } from '../types';

export type DripErrorCode =
  | 'INVALID_ADDRESS'
  | 'RATE_LIMITED'
  | 'DRIP_NOT_CONFIGURED'
  | 'DRIP_FAILED'
  | 'NOT_FUNDED_YET'
  | 'BALANCE_NOT_LOW'
  | 'TOPUP_LIMIT_REACHED'
  | 'BALANCE_UNAVAILABLE'
  | 'ROOM_FULL';

const STATUS: Record<DripErrorCode, number> = {
  INVALID_ADDRESS: 400,
  RATE_LIMITED: 429,
  DRIP_NOT_CONFIGURED: 503,
  DRIP_FAILED: 502,
  NOT_FUNDED_YET: 409,
  BALANCE_NOT_LOW: 409,
  TOPUP_LIMIT_REACHED: 409,
  BALANCE_UNAVAILABLE: 503,
  ROOM_FULL: 409,
};

export class DripError extends Error {
  readonly code: DripErrorCode;
  readonly status: number;
  readonly retryAfterMs: number | null;
  override readonly cause: unknown;

  constructor(code: DripErrorCode, message: string, options: { cause?: unknown; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'DripError';
    this.code = code;
    this.status = STATUS[code];
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The drip transfer was mined and reverted (e.g. Monad's reserve rule): no MON moved, so the
 * address may ask again. Any other confirm failure (a receipt timeout on a busy RPC) is
 * ambiguous: the transfer may still land, so it never gives a drip or a top-up back.
 */
export class DripRevertedError extends Error {
  constructor(readonly txHash: Hash) {
    super(`drip transfer ${txHash} reverted`);
    this.name = 'DripRevertedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface DripSender {
  /** Resolves with the hash once the node accepted the transfer (not once it is mined). */
  send(to: Address): Promise<Hash>;
  /**
   * Optional: resolves once the transfer is mined, rejects with DripRevertedError when it
   * reverted (the address may drip again) or with anything else when it was not seen in time
   * (logged only; the transfer may still land). Runs off the request path.
   */
  confirm?(hash: Hash): Promise<void>;
  /** Optional: drips queued before a new one, and the expected wait while reserve pacing is on (W11). */
  backlog?(): DripBacklog;
}

export interface DripBacklog {
  ahead: number;
  etaMs: number;
}

export interface DripRequest {
  address: string;
  ip: string;
  /** W12: a second (or third) transfer to an address this server already funded. */
  topUp?: boolean;
  /** W19: the session the phone joins (decimal id), for the room cap. */
  sessionId?: string;
}

export interface DripStats {
  fundedAddresses: number;
  ipBuckets: number;
}

export interface DripService {
  drip(request: DripRequest): Promise<DripResult>;
  stats(): DripStats;
}

export interface DripServiceOptions {
  /** null means not configured; only acceptable in mock mode. */
  sender: DripSender | null;
  /** W12: the burner balance read for the top-up rule; required for top-ups outside mock mode. */
  balanceOf?: (address: Address) => Promise<bigint>;
  mock?: boolean;
  maxPerMinutePerIp?: number;
  /** Hard cap across all IPs: bounds the faucet drain rate even if client IPs are spoofed. */
  maxPerMinuteGlobal?: number;
  /** W19: distinct players funded per session; 0 or absent = no cap. */
  maxPlayersPerSession?: number;
  /** Oldest funded addresses are forgotten beyond this many (memory bound; no DB by design). */
  maxRememberedAddresses?: number;
  now?: () => number;
  /** Server-side log for failures. Must never receive key material. */
  log?: (message: string) => void;
}

const WINDOW_MS = 60_000;

/**
 * Review C4: Berlin carriers put many phones behind one IPv4 (carrier-grade NAT) and the
 * whole room joins inside a minute, so the caps are sized for the event: 60 per IP and 300
 * overall. Both are overridable via DRIP_MAX_PER_MINUTE_PER_IP / DRIP_MAX_PER_MINUTE_GLOBAL.
 */
export const DEFAULT_MAX_PER_MINUTE_PER_IP = 60;
export const DEFAULT_MAX_PER_MINUTE_GLOBAL = 300;

/** W19: a room of 20 funded players per session (the drip wallet funds ~12 players per 3.75 MON). */
export const DEFAULT_MAX_PLAYERS_PER_SESSION = 20;

export interface DripLimits {
  maxPerMinutePerIp: number;
  maxPerMinuteGlobal: number;
  maxPlayersPerSession: number;
}

function nonNegativeInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return Number(raw);
}

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return Number(raw);
}

/** Reads the caps from env; unset means the event defaults, malformed throws at boot. */
export function dripLimitsFromEnv(env: Record<string, string | undefined>): DripLimits {
  return {
    maxPerMinutePerIp: positiveInt(env, 'DRIP_MAX_PER_MINUTE_PER_IP', DEFAULT_MAX_PER_MINUTE_PER_IP),
    maxPerMinuteGlobal: positiveInt(env, 'DRIP_MAX_PER_MINUTE_GLOBAL', DEFAULT_MAX_PER_MINUTE_GLOBAL),
    maxPlayersPerSession: nonNegativeInt(env, 'DRIP_MAX_PLAYERS_PER_SESSION', DEFAULT_MAX_PLAYERS_PER_SESSION),
  };
}

interface Funded {
  track: TrackId;
  txHash: Hash | null;
  queue?: DripBacklog;
}

export function createDripService(options: DripServiceOptions): DripService {
  const { sender } = options;
  const mock = options.mock ?? false;
  const maxPerMinute = options.maxPerMinutePerIp ?? DEFAULT_MAX_PER_MINUTE_PER_IP;
  const maxPerMinuteGlobal = options.maxPerMinuteGlobal ?? DEFAULT_MAX_PER_MINUTE_GLOBAL;
  const maxRemembered = options.maxRememberedAddresses ?? 50_000;
  const maxPlayersPerSession = options.maxPlayersPerSession ?? 0;
  /** W19: seats per session (funded or in flight); key '-' for requests without a session. */
  const seats = new Map<string, Set<Address>>();
  const seatOf = new Map<Address, string>();
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((m: string) => console.error(m));

  const funded = new Map<Address, Funded>();
  const inFlight = new Map<Address, Promise<Funded>>();
  /** Top-ups sent (and not given back) per address; never reset while the server runs. */
  const topUps = new Map<Address, number>();
  const topUpInFlight = new Map<Address, Promise<DripResult>>();
  const ipHits = new Map<string, number[]>();
  let globalHits: number[] = [];
  /** Drips past the rate check but not yet sent: they count against the cap until they settle. */
  const ipReserved = new Map<string, number>();
  let globalReserved = 0;
  let lastSweep = 0;
  let nextTrack = 0;

  function assignTrack(): TrackId {
    const track = (nextTrack % TRACKS) as TrackId;
    nextTrack = (nextTrack + 1) % TRACKS;
    return track;
  }

  /** Drop IP buckets with no stamps inside the window; runs at most once per window. */
  function sweep(t: number): void {
    if (t - lastSweep < WINDOW_MS) return;
    lastSweep = t;
    for (const [ip, stamps] of ipHits) {
      if (!stamps.some((s) => s > t - WINDOW_MS)) ipHits.delete(ip);
    }
  }

  function rateLimited(stamps: number[], reserved: number, t: number, limit: number, what: string): void {
    if (stamps.length + reserved < limit) return;
    // With only reservations in the way the slot frees as soon as one of them settles.
    const oldest = stamps[0];
    const retryAfterMs = oldest === undefined ? 1_000 : Math.max(1, oldest + WINDOW_MS - t);
    throw new DripError('RATE_LIMITED', `more than ${limit} drips per minute ${what}`, { retryAfterMs });
  }

  /**
   * Admits the request or throws RATE_LIMITED. A slot is reserved while the send is in
   * flight and only becomes a stamp once fund() succeeded (review C4): a failed drip must
   * not cost the phone its retry.
   */
  function reserve(ip: string): (succeeded: boolean) => void {
    const t = now();
    sweep(t);
    globalHits = globalHits.filter((s) => s > t - WINDOW_MS);
    rateLimited(globalHits, globalReserved, t, maxPerMinuteGlobal, 'in total');
    const stamps = (ipHits.get(ip) ?? []).filter((s) => s > t - WINDOW_MS);
    ipHits.set(ip, stamps);
    rateLimited(stamps, ipReserved.get(ip) ?? 0, t, maxPerMinute, 'from this address');
    ipReserved.set(ip, (ipReserved.get(ip) ?? 0) + 1);
    globalReserved += 1;
    return (succeeded) => {
      const left = (ipReserved.get(ip) ?? 1) - 1;
      if (left <= 0) ipReserved.delete(ip);
      else ipReserved.set(ip, left);
      globalReserved = Math.max(0, globalReserved - 1);
      if (!succeeded) return;
      const at = now();
      const bucket = ipHits.get(ip) ?? [];
      bucket.push(at);
      ipHits.set(ip, bucket);
      globalHits.push(at);
    };
  }

  function remember(address: Address, result: Funded): void {
    funded.set(address, result);
    while (funded.size > maxRemembered) {
      const oldest = funded.keys().next().value;
      if (oldest === undefined) break;
      funded.delete(oldest);
    }
  }

  /** Takes a seat in the session's room, or throws ROOM_FULL. */
  function takeSeat(address: Address, sessionId: string | undefined): void {
    if (maxPlayersPerSession <= 0) return;
    const key = sessionId ?? '-';
    const room = seats.get(key) ?? new Set<Address>();
    if (!room.has(address) && room.size >= maxPlayersPerSession) {
      throw new DripError('ROOM_FULL', `the room is full: ${maxPlayersPerSession} players are already funded in this session`);
    }
    room.add(address);
    seats.set(key, room);
    seatOf.set(address, key);
  }

  function giveSeatBack(address: Address): void {
    const key = seatOf.get(address);
    if (key === undefined) return;
    seatOf.delete(address);
    seats.get(key)?.delete(address);
  }

  /** Background receipt watch (review C3): a transfer that never lands must not leave the phone "already funded". */
  function watchConfirmation(address: Address, txHash: Hash): void {
    if (!sender?.confirm) return;
    sender.confirm(txHash).then(
      () => undefined,
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        if (!(error instanceof DripRevertedError)) {
          log(`drip: transfer ${txHash} to ${address} not confirmed: ${detail}; kept as funded (it may still land)`);
          return;
        }
        log(`drip: transfer ${txHash} to ${address} reverted: ${detail}; the address may drip again`);
        if (funded.get(address)?.txHash === txHash) {
          funded.delete(address);
          giveSeatBack(address);
        }
      },
    );
  }

  async function fund(address: Address): Promise<Funded> {
    const track = assignTrack();
    if (mock) return { track, txHash: null };
    if (!sender) throw new DripError('DRIP_NOT_CONFIGURED', 'DRIP_PRIVATE_KEY is not configured');
    try {
      const queue = sender.backlog?.();
      const txHash = await sender.send(address);
      return queue ? { track, txHash, queue } : { track, txHash };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`drip: send to ${address} failed: ${detail}`);
      throw new DripError('DRIP_FAILED', 'drip transaction failed', { cause: error });
    }
  }

  /**
   * A top-up that reverted is given back so the phone can ask again. A receipt timeout is not
   * (security review): the transfer may still land, and refunding it would let a slow RPC lift
   * the cap of MAX_TOP_UPS_PER_ADDRESS.
   */
  function watchTopUp(address: Address, txHash: Hash): void {
    if (!sender?.confirm) return;
    sender.confirm(txHash).then(
      () => undefined,
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        if (!(error instanceof DripRevertedError)) {
          log(`drip: top-up ${txHash} to ${address} not confirmed: ${detail}; still counted (it may land)`);
          return;
        }
        log(`drip: top-up ${txHash} to ${address} reverted: ${detail}; the top-up is not counted`);
        const used = topUps.get(address) ?? 0;
        if (used > 0) topUps.set(address, used - 1);
      },
    );
  }

  async function checkTopUpBalance(address: Address): Promise<void> {
    if (mock) return;
    if (!options.balanceOf) throw new DripError('BALANCE_UNAVAILABLE', 'top-ups need a balance source on the server');
    let balance: bigint;
    try {
      balance = await options.balanceOf(address);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`drip: balance read for top-up of ${address} failed: ${detail}`);
      throw new DripError('BALANCE_UNAVAILABLE', 'could not read the wallet balance; try again', { cause: error });
    }
    if (balance >= TOP_UP_BELOW_WEI) {
      throw new DripError('BALANCE_NOT_LOW', `top-ups open below ${formatMon(TOP_UP_BELOW_WEI)} MON; this wallet holds ${formatMon(balance)} MON`);
    }
  }

  async function topUp(address: Address, ip: string, previous: Funded): Promise<DripResult> {
    const used = topUps.get(address) ?? 0;
    if (used >= MAX_TOP_UPS_PER_ADDRESS) {
      throw new DripError('TOPUP_LIMIT_REACHED', `this wallet already had ${MAX_TOP_UPS_PER_ADDRESS} top-ups`);
    }
    const settle = reserve(ip);
    let succeeded = false;
    try {
      await checkTopUpBalance(address);
      let txHash: Hash | null = null;
      let queue: DripBacklog | undefined;
      if (!mock) {
        if (!sender) throw new DripError('DRIP_NOT_CONFIGURED', 'DRIP_PRIVATE_KEY is not configured');
        queue = sender.backlog?.();
        try {
          txHash = await sender.send(address);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log(`drip: top-up to ${address} failed: ${detail}`);
          throw new DripError('DRIP_FAILED', 'top-up transaction failed', { cause: error });
        }
      }
      succeeded = true;
      const count = (topUps.get(address) ?? 0) + 1;
      topUps.set(address, count);
      if (txHash !== null) watchTopUp(address, txHash);
      return {
        txHash,
        track: previous.track,
        alreadyFunded: false,
        topUp: true,
        topUpsLeft: Math.max(0, MAX_TOP_UPS_PER_ADDRESS - count),
        ...(queue ? { queuedAhead: queue.ahead, etaMs: queue.etaMs } : {}),
      };
    } finally {
      settle(succeeded);
    }
  }

  return {
    async drip({ address: raw, ip, topUp: wantsTopUp, sessionId }): Promise<DripResult> {
      if (typeof raw !== 'string' || !isAddress(raw)) {
        throw new DripError('INVALID_ADDRESS', 'address must be a 0x-prefixed 20-byte hex string');
      }
      const address = getAddress(raw);

      if (wantsTopUp === true) {
        const previous = funded.get(address);
        if (!previous) throw new DripError('NOT_FUNDED_YET', 'this wallet was never funded here; ask for a first drip');
        const pendingTopUp = topUpInFlight.get(address);
        if (pendingTopUp) return pendingTopUp;
        const promise = topUp(address, ip, previous);
        topUpInFlight.set(address, promise);
        try {
          return await promise;
        } finally {
          topUpInFlight.delete(address);
        }
      }

      const existing = funded.get(address);
      if (existing) return { txHash: null, track: existing.track, alreadyFunded: true };

      const pending = inFlight.get(address);
      if (pending) {
        const result = await pending;
        return { txHash: null, track: result.track, alreadyFunded: true };
      }

      takeSeat(address, sessionId);
      let settle: (succeeded: boolean) => void;
      try {
        settle = reserve(ip);
      } catch (error) {
        giveSeatBack(address);
        throw error;
      }

      const promise = fund(address);
      inFlight.set(address, promise);
      let succeeded = false;
      try {
        const result = await promise;
        succeeded = true;
        remember(address, result);
        if (result.txHash !== null) watchConfirmation(address, result.txHash);
        return {
          txHash: result.txHash,
          track: result.track,
          alreadyFunded: false,
          ...(result.queue ? { queuedAhead: result.queue.ahead, etaMs: result.queue.etaMs } : {}),
        };
      } finally {
        inFlight.delete(address);
        if (!succeeded) giveSeatBack(address);
        settle(succeeded);
      }
    },
    stats() {
      return { fundedAddresses: funded.size, ipBuckets: ipHits.size };
    },
  };
}
