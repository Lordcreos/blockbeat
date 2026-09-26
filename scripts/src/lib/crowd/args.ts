/** W19: flags of `pnpm --filter scripts crowd -- …` (see src/crowd.ts). */
import { parseEther } from 'viem';
import { MAX_LIVE_PER_TRACK, MAX_NOTE_LIFETIME_BARS, NOTE_LIFETIME_BARS, NOTES_PER_TRACK, PUBLIC_RPC_RPS } from '@blockbeat/shared';
import { CHAIN_FLAGS, assertKnown, boolFlag, intFlag, parseChainOptions, parseFlags, sanitizeNote, type ChainOptions, type Env } from '../args';

export const MAX_PLAYERS = 30;
export const MAX_MINUTES = 15;
/** A hard ceiling on --max-mon: the drip wallet funds real phones too. */
export const MAX_BUDGET_MON = 5;
export const DEFAULT_BUDGET_MON = '1.5';

export interface CrowdPlayArgs extends ChainOptions {
  mode: 'play';
  sessionId: bigint;
  players: number;
  minutes: number;
  maxWei: bigint;
  seed: number;
  notesPerPlayer: number | null;
  rps: number;
  blockMs: number;
  hitTimeoutMs: number;
  lifetimeBars: number;
  maxLivePerTrack: number;
  note: string | null;
  /** Visible mode (`--ui`): headed phones on the join page; null for the headless crowd. */
  ui: { baseUrl: string | null; snapshotAtBar: number | null; play: 'tap' | 'aim' } | null;
}

export interface CrowdSweepArgs extends ChainOptions {
  mode: 'sweep-only';
  rps: number;
  blockMs: number;
}

export type CrowdArgs = CrowdPlayArgs | CrowdSweepArgs;

const FLAGS = [...CHAIN_FLAGS, 'session', 'players', 'minutes', 'max-mon', 'seed', 'notes-per-player', 'rps', 'block-ms', 'hit-timeout-ms', 'sweep-only', 'note', 'ui', 'base-url', 'snapshot-bar', 'play'] as const;

export const MAX_VISIBLE_PLAYERS = 6;

function baseUrlFlag(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--base-url must be an http(s) URL, got "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`--base-url must be an http(s) URL, got "${raw}"`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function numberFlag(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= min || n > max) throw new Error(`--${name} must be a number above ${min} and at most ${max}, got "${raw}"`);
  return n;
}

function envInt(env: Env, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${name} must be an integer in 0..${max}, got "${raw}"`);
  return n;
}

export function parseCrowdArgs(argv: readonly string[], env: Env, randomSeed: () => number = () => Math.floor(Math.random() * 2 ** 31)): CrowdArgs {
  const flags = parseFlags(argv);
  assertKnown(flags, FLAGS);
  const chain = parseChainOptions(flags, env);
  const rps = intFlag(flags, 'rps', 15, 1, PUBLIC_RPC_RPS);
  const blockMs = intFlag(flags, 'block-ms', 300, 1, 60_000);
  if (boolFlag(flags, 'sweep-only')) return { ...chain, mode: 'sweep-only', rps, blockMs };

  const rawSession = flags['session'];
  if (rawSession === undefined || rawSession === 'true') throw new Error('--session <id> is required (the session the crowd plays in)');
  const sessionId = BigInt(intFlag(flags, 'session', 0, 1));
  const maxRaw = flags['max-mon'] ?? DEFAULT_BUDGET_MON;
  const maxMon = Number(maxRaw);
  if (!/^\d+(\.\d{1,18})?$/.test(maxRaw) || !(maxMon > 0) || maxMon > MAX_BUDGET_MON) throw new Error(`--max-mon must be a decimal MON amount above 0 and at most ${MAX_BUDGET_MON}, got "${maxRaw}"`);
  const notesRaw = flags['notes-per-player'];
  const rawPlay = flags['play'] ?? 'tap';
  if (rawPlay !== 'tap' && rawPlay !== 'aim') throw new Error(`--play must be tap or aim, got "${rawPlay}"`);
  const play: 'tap' | 'aim' = rawPlay;
  const ui = boolFlag(flags, 'ui') ? { baseUrl: baseUrlFlag(flags['base-url']), snapshotAtBar: flags['snapshot-bar'] === undefined ? null : intFlag(flags, 'snapshot-bar', 0, 0, 1000), play } : null;
  return {
    ...chain,
    mode: 'play',
    sessionId,
    players: ui ? intFlag(flags, 'players', 5, 1, MAX_VISIBLE_PLAYERS) : intFlag(flags, 'players', 10, 1, MAX_PLAYERS),
    minutes: numberFlag(flags['minutes'], 'minutes', 3, 0, MAX_MINUTES),
    maxWei: parseEther(maxRaw),
    seed: flags['seed'] === undefined ? randomSeed() : intFlag(flags, 'seed', 0, 0, 2 ** 31),
    notesPerPlayer: notesRaw === undefined ? null : intFlag(flags, 'notes-per-player', 0, 1, NOTES_PER_TRACK * 16),
    rps,
    blockMs,
    hitTimeoutMs: intFlag(flags, 'hit-timeout-ms', 15_000, 100),
    lifetimeBars: envInt(env, 'NEXT_PUBLIC_NOTE_LIFETIME_BARS', NOTE_LIFETIME_BARS, MAX_NOTE_LIFETIME_BARS),
    maxLivePerTrack: envInt(env, 'NEXT_PUBLIC_MAX_LIVE_PER_TRACK', MAX_LIVE_PER_TRACK, NOTES_PER_TRACK * 16),
    note: flags['note'] === undefined ? null : sanitizeNote(flags['note']),
    ui,
  };
}
