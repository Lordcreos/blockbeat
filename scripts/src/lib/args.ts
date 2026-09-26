/** Minimal --flag parsing plus the typed option sets for the three CLIs. */
import { isAddress, type Address } from 'viem';
import { ANVIL_ID, MONAD_TESTNET_ID, PUBLIC_RPC_RPS, blockbeatAddress, chainById } from '@blockbeat/shared';

export type Flags = Record<string, string>;

export function parseFlags(argv: readonly string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    // pnpm 9 forwards the `--` in `pnpm --filter scripts <cli> -- --flag` to the script.
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new Error(`unexpected positional argument "${arg}"`);
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[arg.slice(2)] = next;
      i += 1;
    } else {
      out[arg.slice(2)] = 'true';
    }
  }
  return out;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function intFlag(flags: Flags, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer in ${min}..${max}, got "${raw}"`);
  return n;
}

export function boolFlag(flags: Flags, name: string): boolean {
  const raw = flags[name];
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export function assertKnown(flags: Flags, known: readonly string[]): void {
  for (const k of Object.keys(flags)) {
    if (!known.includes(k)) throw new Error(`unknown flag --${k}; known: ${known.map((x) => `--${x}`).join(' ')}`);
  }
}

export interface ChainOptions {
  chainId: number;
  chainName: string;
  rpc: string;
  ws: string;
  address: Address;
}

export const CHAIN_FLAGS = ['rpc', 'ws', 'chain-id', 'address'] as const;

export function parseChainOptions(flags: Flags, env: Env): ChainOptions {
  const chainId = intFlag(flags, 'chain-id', MONAD_TESTNET_ID, 1);
  const chain = chainById(chainId);
  if (chain.id !== chainId) throw new Error(`--chain-id ${chainId} is not supported (known: ${MONAD_TESTNET_ID}, ${ANVIL_ID})`);
  const rpc = flags['rpc'] ?? env['MONAD_RPC_URL'] ?? chain.rpcUrls.default.http[0];
  const ws = flags['ws'] ?? env['MONAD_WS_URL'] ?? chain.rpcUrls.default.webSocket?.[0] ?? '';
  const rawAddress = flags['address'] ?? env['BLOCKBEAT_ADDRESS'] ?? blockbeatAddress(chainId);
  if (!isAddress(rawAddress)) throw new Error(`--address "${rawAddress}" is not a valid address`);
  return { chainId, chainName: chain.name, rpc, ws, address: rawAddress };
}

export interface LoadtestOptions extends ChainOptions {
  sessionId: bigint;
  wallets: number;
  hits: number;
  windowMs: number;
  rps: number;
  blockMs: number;
  lagBlocks: number;
  hitTimeoutMs: number;
  seed: number;
  sweep: boolean;
  receipts: 'all' | 'sample' | 'none';
  fundMon: string | null;
  note: string | null;
}

const LOADTEST_FLAGS = [...CHAIN_FLAGS, 'session', 'wallets', 'hits', 'window-ms', 'rps', 'allow-over-limit', 'block-ms', 'lag-blocks', 'hit-timeout-ms', 'seed', 'sweep', 'receipts', 'fund-mon', 'note'] as const;

export function parseLoadtestArgs(argv: readonly string[], env: Env): LoadtestOptions {
  const flags = parseFlags(argv);
  assertKnown(flags, LOADTEST_FLAGS);
  const chain = parseChainOptions(flags, env);
  const rps = intFlag(flags, 'rps', PUBLIC_RPC_RPS, 1);
  if (rps > PUBLIC_RPC_RPS && !boolFlag(flags, 'allow-over-limit')) {
    throw new Error(`--rps ${rps} exceeds the public RPC limit of ${PUBLIC_RPC_RPS}; pass --allow-over-limit for a dedicated provider`);
  }
  const receipts = flags['receipts'] ?? 'sample';
  if (receipts !== 'all' && receipts !== 'sample' && receipts !== 'none') throw new Error(`--receipts must be all|sample|none, got "${receipts}"`);
  const isAnvil = chain.chainId === ANVIL_ID;
  return {
    ...chain,
    sessionId: BigInt(intFlag(flags, 'session', 1, 1)),
    wallets: intFlag(flags, 'wallets', 40, 1, 10_000),
    hits: intFlag(flags, 'hits', 30, 1, 10_000),
    windowMs: intFlag(flags, 'window-ms', 60_000, 1),
    rps,
    blockMs: intFlag(flags, 'block-ms', isAnvil ? 1000 : 300, 1),
    lagBlocks: intFlag(flags, 'lag-blocks', isAnvil ? 0 : 1, 0, 16),
    hitTimeoutMs: intFlag(flags, 'hit-timeout-ms', 15_000, 100),
    seed: intFlag(flags, 'seed', 1, 0),
    sweep: boolFlag(flags, 'sweep'),
    receipts,
    fundMon: flags['fund-mon'] ?? null,
    note: flags['note'] === undefined ? null : sanitizeNote(flags['note']),
  };
}

/** Notes are committed into Markdown: printable characters only, one line, capped. */
export function sanitizeNote(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim().slice(0, 200);
}

export interface FundDripOptions extends ChainOptions {
  players: number;
  dripAmountMon: string;
}

export function parseFundDripArgs(argv: readonly string[], env: Env, defaultDripMon: string): FundDripOptions {
  const flags = parseFlags(argv);
  assertKnown(flags, [...CHAIN_FLAGS, 'players', 'drip-mon']);
  return {
    ...parseChainOptions(flags, env),
    players: intFlag(flags, 'players', 60, 1),
    dripAmountMon: flags['drip-mon'] ?? env['DRIP_AMOUNT_MON'] ?? defaultDripMon,
  };
}

export interface SessionOptions extends ChainOptions {
  start: boolean;
  finalize: bigint | null;
  status: bigint | null;
}

export function parseSessionArgs(argv: readonly string[], env: Env): SessionOptions {
  const flags = parseFlags(argv);
  assertKnown(flags, [...CHAIN_FLAGS, 'start', 'finalize', 'status']);
  const finalizeRaw = flags['finalize'];
  const statusRaw = flags['status'];
  const opts: SessionOptions = {
    ...parseChainOptions(flags, env),
    start: boolFlag(flags, 'start'),
    finalize: finalizeRaw !== undefined && finalizeRaw !== 'true' ? BigInt(intFlag(flags, 'finalize', 0, 1)) : null,
    status: statusRaw !== undefined && statusRaw !== 'true' ? BigInt(intFlag(flags, 'status', 0, 1)) : null,
  };
  if (finalizeRaw === 'true') throw new Error('--finalize needs a session id');
  if (statusRaw === 'true') throw new Error('--status needs a session id');
  if (!opts.start && opts.finalize === null && opts.status === null) throw new Error('nothing to do: pass --start, --finalize <id> or --status <id>');
  return opts;
}
