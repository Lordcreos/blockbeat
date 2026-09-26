/**
 * W21b: the tipper drip. `POST /api/drip { address, mode: "tipper" }` funds the tip page's
 * burner (its own storage key, never the player's) once with a small fixed amount
 * (TIPPER_DRIP_MON, 0.1: one 0.05 MON tip plus another after it at the fixed tip gas).
 *
 * Counted apart from the player drip: its own per-IP and global per-minute limits and a
 * lifetime cap (TIP_DRIP_MAX_TOTAL), so tippers never eat the players' budget and a flood
 * from spoofed IPs drains at most maxTotal × amount. It sends through the SAME DripSender as
 * the player drip, so the one drip key keeps one nonce queue and the W11 reserve pacing.
 * A transfer that reverted gives its slot back; one that timed out does not (it may land).
 */
import { getAddress, isAddress, parseEther, type Address, type Hash } from 'viem';
import { TIPPER_DRIP_MON } from '../tips/constants';
import { RateLimitedError, createWindowRateLimiter } from '../tips/rateLimit';
import { DripRevertedError, type DripSender } from './service';

export type TipperDripErrorCode = 'INVALID_ADDRESS' | 'INVALID_SESSION' | 'RATE_LIMITED' | 'TIPPERS_EXHAUSTED' | 'DRIP_NOT_CONFIGURED' | 'DRIP_FAILED';

const STATUS: Record<TipperDripErrorCode, number> = {
  INVALID_ADDRESS: 400,
  INVALID_SESSION: 400,
  RATE_LIMITED: 429,
  TIPPERS_EXHAUSTED: 503,
  DRIP_NOT_CONFIGURED: 503,
  DRIP_FAILED: 502,
};

export class TipperDripError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  override readonly cause: unknown;
  constructor(
    readonly code: TipperDripErrorCode,
    message: string,
    options: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'TipperDripError';
    this.status = STATUS[code];
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface TipperDripResult {
  txHash: Hash | null;
  alreadyFunded: boolean;
  /** Wei sent (decimal string): the phone credits the simulator with it in mock mode. */
  amountWei: string;
  queuedAhead?: number;
  etaMs?: number;
}

export interface TipperLimits {
  maxPerMinutePerIp: number;
  maxPerMinuteGlobal: number;
  /** Tipper wallets funded per server lifetime, all sessions together: the MON bound (maxTotal × amount). */
  maxTotal: number;
  /**
   * Security review (HIGH): tipper wallets per session, and per client IP within a session, so
   * one actor with throwaway addresses can use up one show's tips at most, never the event's.
   */
  maxPerSession: number;
  maxPerIpPerSession: number;
}

export const DEFAULT_TIPPER_LIMITS: TipperLimits = { maxPerMinutePerIp: 20, maxPerMinuteGlobal: 60, maxTotal: 150, maxPerSession: 50, maxPerIpPerSession: 25 };
/** A misconfigured amount must not turn the tip page into a faucet. */
export const MAX_TIPPER_DRIP_WEI = parseEther('0.5');

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return Number(raw);
}

export function tipperLimitsFromEnv(env: Record<string, string | undefined>): TipperLimits {
  return {
    maxPerMinutePerIp: positiveInt(env, 'TIP_DRIP_MAX_PER_MINUTE_PER_IP', DEFAULT_TIPPER_LIMITS.maxPerMinutePerIp),
    maxPerMinuteGlobal: positiveInt(env, 'TIP_DRIP_MAX_PER_MINUTE_GLOBAL', DEFAULT_TIPPER_LIMITS.maxPerMinuteGlobal),
    maxTotal: positiveInt(env, 'TIP_DRIP_MAX_TOTAL', DEFAULT_TIPPER_LIMITS.maxTotal),
    maxPerSession: positiveInt(env, 'TIP_DRIP_MAX_PER_SESSION', DEFAULT_TIPPER_LIMITS.maxPerSession),
    maxPerIpPerSession: positiveInt(env, 'TIP_DRIP_MAX_PER_IP_PER_SESSION', DEFAULT_TIPPER_LIMITS.maxPerIpPerSession),
  };
}

export function tipperAmountFromEnv(env: Record<string, string | undefined>): bigint {
  const raw = env.TIP_DRIP_AMOUNT_MON?.trim() || TIPPER_DRIP_MON;
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) throw new Error(`TIP_DRIP_AMOUNT_MON must be a decimal MON amount, got "${raw}"`);
  const wei = parseEther(raw);
  if (wei <= 0n) throw new Error('TIP_DRIP_AMOUNT_MON must be above zero');
  if (wei > MAX_TIPPER_DRIP_WEI) throw new Error(`TIP_DRIP_AMOUNT_MON must be at most 0.5 MON, got ${raw}`);
  return wei;
}

export interface TipperDripService {
  drip(request: { address: string; ip: string; sessionId: bigint }): Promise<TipperDripResult>;
  stats(): { funded: number; remaining: number };
}

export interface TipperDripServiceOptions {
  sender: DripSender | null;
  mock: boolean;
  amountWei: bigint;
  limits: TipperLimits;
  now?: () => number;
  /** Server log; never receives key material. */
  log?: (message: string) => void;
}

export function createTipperDripService(options: TipperDripServiceOptions): TipperDripService {
  const { sender, mock, amountWei, limits } = options;
  const log = options.log ?? ((m: string) => console.error(m));
  const limiter = createWindowRateLimiter({ perKey: limits.maxPerMinutePerIp, global: limits.maxPerMinuteGlobal, ...(options.now ? { now: options.now } : {}) });
  const funded = new Map<Address, Hash | null>();
  /** Slots per session and per session+IP, taken when a drip starts and given back when it fails or reverts. */
  const perSession = new Map<string, number>();
  const perIpSession = new Map<string, number>();
  const slotsOf = new Map<Address, string[]>();
  const bump = (m: Map<string, number>, k: string, by: number): void => {
    const n = (m.get(k) ?? 0) + by;
    if (n <= 0) m.delete(k);
    else m.set(k, n);
  };
  function release(address: Address): void {
    const keys = slotsOf.get(address);
    if (!keys) return;
    slotsOf.delete(address);
    const [sessionKey, ipKey] = keys;
    if (sessionKey) bump(perSession, sessionKey, -1);
    if (ipKey) bump(perIpSession, ipKey, -1);
  }
  const inFlight = new Map<Address, Promise<TipperDripResult>>();
  const amount = amountWei.toString();

  function watch(address: Address, txHash: Hash): void {
    if (!sender?.confirm) return;
    sender.confirm(txHash).then(
      () => undefined,
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        if (!(error instanceof DripRevertedError)) {
          log(`drip: tipper transfer ${txHash} to ${address} not confirmed: ${detail}; kept as funded (it may still land)`);
          return;
        }
        log(`drip: tipper transfer ${txHash} to ${address} reverted; the address may ask again`);
        if (funded.get(address) === txHash) {
          funded.delete(address);
          release(address);
        }
      },
    );
  }

  async function fund(address: Address, ip: string, sessionId: bigint): Promise<TipperDripResult> {
    if (funded.size + inFlight.size >= limits.maxTotal) {
      throw new TipperDripError('TIPPERS_EXHAUSTED', 'no more tipper wallets can be funded on this server');
    }
    const sessionKey = sessionId.toString();
    const ipKey = `${sessionKey}|${ip}`;
    if ((perSession.get(sessionKey) ?? 0) >= limits.maxPerSession) {
      throw new TipperDripError('TIPPERS_EXHAUSTED', 'no more tipper wallets for this session');
    }
    if ((perIpSession.get(ipKey) ?? 0) >= limits.maxPerIpPerSession) {
      throw new TipperDripError('RATE_LIMITED', 'too many tipper wallets for this session from this address');
    }
    try {
      limiter.take(ip);
    } catch (error) {
      if (error instanceof RateLimitedError) throw new TipperDripError('RATE_LIMITED', error.message, { retryAfterMs: error.retryAfterMs });
      throw error;
    }
    bump(perSession, sessionKey, 1);
    bump(perIpSession, ipKey, 1);
    slotsOf.set(address, [sessionKey, ipKey]);
    if (mock) {
      funded.set(address, null);
      return { txHash: null, alreadyFunded: false, amountWei: amount };
    }
    if (!sender) {
      release(address);
      throw new TipperDripError('DRIP_NOT_CONFIGURED', 'DRIP_PRIVATE_KEY is not configured');
    }
    const queue = sender.backlog?.();
    let txHash: Hash;
    try {
      txHash = await sender.send(address, amountWei);
    } catch (error) {
      release(address);
      log(`drip: tipper send to ${address} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new TipperDripError('DRIP_FAILED', 'tipper drip transaction failed', { cause: error });
    }
    funded.set(address, txHash);
    watch(address, txHash);
    return { txHash, alreadyFunded: false, amountWei: amount, ...(queue ? { queuedAhead: queue.ahead, etaMs: queue.etaMs } : {}) };
  }

  return {
    async drip({ address: raw, ip, sessionId }) {
      if (typeof raw !== 'string' || !isAddress(raw)) {
        throw new TipperDripError('INVALID_ADDRESS', 'address must be a 0x-prefixed 20-byte hex string');
      }
      const address = getAddress(raw);
      if (funded.has(address)) return { txHash: null, alreadyFunded: true, amountWei: amount };
      const pending = inFlight.get(address);
      if (pending) {
        await pending;
        return { txHash: null, alreadyFunded: true, amountWei: amount };
      }
      // Registered before the first await: a concurrent request for the address joins this one.
      if (sessionId <= 0n) throw new TipperDripError('INVALID_SESSION', 'sessionId must be a positive integer');
      const promise = fund(address, ip, sessionId);
      inFlight.set(address, promise);
      try {
        return await promise;
      } finally {
        inFlight.delete(address);
      }
    },
    stats() {
      return { funded: funded.size, remaining: Math.max(0, limits.maxTotal - funded.size - inFlight.size) };
    },
  };
}
