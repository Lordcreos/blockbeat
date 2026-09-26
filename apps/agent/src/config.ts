/**
 * Environment → typed config. Keys are validated but never echoed in errors or logs.
 */
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { A_MINOR, parseKey, type Key } from './lib/music/theory';
import { MAX_PHRASE_NOTES } from './lib/brain/types';
import { MONAD_TESTNET_ID, SUPPORTED_CHAINS, ZERO_ADDRESS, blockbeatAddress, chainById, parseMaxLivePerTrack, parseNoteLifetimeBars } from '@blockbeat/shared';

export interface AgentConfig {
  chainId: number;
  rpcUrl: string;
  wsUrl: string | null;
  blockbeatAddress: Address;
  privateKey: Hex;
  anthropicApiKey: string | null;
  /** Claude model (AGENT_MODEL). */
  model: string;
  /** W12: which brain plans each bar (AGENT_BRAIN); the rules brain is always the fallback. */
  brain: BrainChoice;
  openaiApiKey: string | null;
  /** W12: OpenAI model (OPENAI_MODEL); default is OpenAI's small fast model. */
  openaiModel: string;
  /** W14b: Responses API reasoning.effort (OPENAI_REASONING_EFFORT); gpt-6-luna defaults to none, others to the model default (null). */
  openaiReasoningEffort: string | null;
  /** W14: Google AI Studio key (GEMINI_API_KEY, else GOOGLE_API_KEY). */
  geminiApiKey: string | null;
  /** W14: Gemini model (GEMINI_MODEL). */
  geminiModel: string;
  /** W14: client-side Gemini requests per minute (GEMINI_RPM, default 5 = the free tier; 0 = no cap). */
  geminiRpm: number;
  /** AGENT_LLM_TIMEOUT_MS; default 4000 for openai (W14b) and gemini, 3000 for anthropic. */
  llmTimeoutMs: number;
  enabled: boolean;
  /** W17: default 160 (a phrase is up to 8 notes a bar; ~45 hits per 20-bar cycle in an empty room). */
  maxHitsPerSession: number;
  /** W17: AGENT_MAX_NOTES_PER_BAR, 0..8 (default 8). */
  maxNotesPerBar: number;
  /** W17: AGENT_KEY, e.g. "A minor" (default; every pitched voice of the kit is tuned to A). */
  key: Key;
  /** W17: AGENT_DEBUG_LLM, log the raw LLM answer (model output only, never a key). */
  debugLlm: boolean;
  /** W17: AGENT_SET_START_BAR, the arrangement bar the set opens on (0 intro, 4 build, 8 peak, 16 breakdown). */
  setStartBar: number;
  sessionId: bigint;
  /** Stop after this many bars (evidence runs); null runs until SIGINT. */
  bars: number | null;
  identityRegistry: Address | null;
  statePath: string;
  /**
   * W13: note decay and voice cap. The agent reads the stage's own knobs
   * (NEXT_PUBLIC_NOTE_LIFETIME_BARS, NEXT_PUBLIC_MAX_LIVE_PER_TRACK; the stage passes them to
   * the DJ it spawns) so it plans on exactly the grid the room hears. 0 turns either off.
   */
  decay: { lifetimeBars: number; maxLivePerTrack: number };
}

export type Env = Record<string, string | undefined>;

export type BrainChoice = 'anthropic' | 'gemini' | 'openai' | 'rules';

/**
 * W12 default OpenAI model: "gpt-6-luna", listed by OpenAI (developers.openai.com/api/docs/models,
 * read 2026-09-25) as its most efficient model for focused, high-volume tasks, with Structured
 * Outputs on the Responses API. Override with OPENAI_MODEL.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

/**
 * W14 (measured 2026-09-25, docs/evidence/w14-gemini-brain): gemini-3.6-flash with MINIMAL thinking
 * answered the DJ prompt in 1.4-3.3 s; gemini-3.8-flash (LOW is its floor) took 9 s, too slow for a
 * 4.8 s bar. 3.8 stays selectable with GEMINI_MODEL. p95 > 2.5 s, so the gemini default timeout is 4 s
 * (the loop plans the next bar and moves a late answer one bar on).
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
export const DEFAULT_GEMINI_TIMEOUT_MS = 4000;
/** W14: the AI Studio free tier allows 5 generateContent requests per minute per model (429 QuotaFailure, measured). */
export const DEFAULT_GEMINI_RPM = 5;
const DEFAULT_LLM_TIMEOUT_MS = 3000;

/**
 * W14b: the live DJ brain is OpenAI (gpt-6-luna, reasoning none). The coordinator measured it on the
 * Responses API with the DJ prompt: effort none 1.5-3.5 s, low 2.7-3.2 s, default 2.8-4.9 s;
 * 'minimal' is rejected for luna (400). Deadline 4 s, the loop plans the next bar.
 */
export const DEFAULT_OPENAI_TIMEOUT_MS = 4000;
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

function reasoningEffort(env: Env, model: string): string | null {
  const raw = env.OPENAI_REASONING_EFFORT?.trim().toLowerCase();
  if (!raw) return /^gpt-6-luna\b/.test(model) ? 'none' : null;
  if (!(REASONING_EFFORTS as readonly string[]).includes(raw)) throw new Error(`OPENAI_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(', ')}`);
  return raw;
}

/** AGENT_BRAIN, or (W14b): anthropic with a Claude key, else openai, else gemini (dormant), else rules. */
function brainChoice(env: Env, anthropicKey: string | null, geminiKey: string | null, openaiKey: string | null): BrainChoice {
  const raw = env.AGENT_BRAIN?.trim().toLowerCase();
  if (!raw) return anthropicKey ? 'anthropic' : openaiKey ? 'openai' : geminiKey ? 'gemini' : 'rules';
  if (raw === 'rules') return 'rules';
  if (raw === 'anthropic') {
    if (!anthropicKey) throw new Error('AGENT_BRAIN=anthropic needs ANTHROPIC_API_KEY');
    return 'anthropic';
  }
  if (raw === 'openai') {
    if (!openaiKey) throw new Error('AGENT_BRAIN=openai needs OPENAI_API_KEY');
    return 'openai';
  }
  if (raw === 'gemini') {
    if (!geminiKey) throw new Error('AGENT_BRAIN=gemini needs GEMINI_API_KEY (or GOOGLE_API_KEY)');
    return 'gemini';
  }
  throw new Error('AGENT_BRAIN must be anthropic, gemini, openai or rules');
}

function intVar(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

function boolVar(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

/** W17: the session budget; ~45 hits per 20-bar cycle in an empty room, so about 3.5 cycles (6 minutes, ~1.6 MON). */
export const DEFAULT_MAX_HITS_PER_SESSION = 160;

function notesPerBar(env: Env): number {
  const n = intVar(env, 'AGENT_MAX_NOTES_PER_BAR', MAX_PHRASE_NOTES, 0);
  if (n > MAX_PHRASE_NOTES) throw new Error(`AGENT_MAX_NOTES_PER_BAR must be at most ${MAX_PHRASE_NOTES} (the phrase limit)`);
  return n;
}

function keyVar(env: Env): Key {
  const raw = env.AGENT_KEY?.trim();
  if (!raw) return A_MINOR;
  try {
    return parseKey(raw);
  } catch (error) {
    throw new Error(`AGENT_KEY: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addressVar(env: Env, name: string): Address | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  if (!isAddress(raw)) throw new Error(`${name} is not a valid address`);
  return getAddress(raw);
}

/**
 * Command-line overrides (review M9): `--session <id>` or `--session=<id>` wins over
 * AGENT_SESSION_ID, so the pitch session created minutes before can be passed without
 * editing .env. Unknown flags are rejected so a typo never runs against the .env session.
 */
export function parseArgs(argv: readonly string[]): { sessionId: bigint | null } {
  let sessionId: bigint | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    let value: string | undefined;
    if (arg === '--session') value = argv[++i];
    else if (arg.startsWith('--session=')) value = arg.slice('--session='.length);
    else throw new Error(`unknown argument ${arg} (only --session <id> is accepted)`);
    if (value === undefined || !/^\d+$/.test(value) || BigInt(value) === 0n) throw new Error('--session must be a positive integer');
    sessionId = BigInt(value);
  }
  return { sessionId };
}

export function loadConfig(env: Env, argv: readonly string[] = []): AgentConfig {
  const args = parseArgs(argv);
  const chainId = intVar(env, 'AGENT_CHAIN_ID', MONAD_TESTNET_ID, 1);
  // chainById falls back to Monad testnet metadata for unknown ids; never let that pick an RPC.
  const known = chainId in SUPPORTED_CHAINS;
  const chain = chainById(chainId);
  const rpcUrl = env.AGENT_RPC_URL || (known ? chain.rpcUrls.default.http[0] : undefined);
  if (!rpcUrl) throw new Error(`AGENT_RPC_URL is required for chain ${chainId} (not a known chain)`);
  const wsUrl = env.AGENT_WS_URL || (env.AGENT_RPC_URL ? env.AGENT_RPC_URL.replace(/^http/, 'ws') : known ? chain.rpcUrls.default.webSocket?.[0] : undefined) || null;

  const privateKey = env.AGENT_PRIVATE_KEY;
  if (!privateKey) throw new Error('AGENT_PRIVATE_KEY is required (see .env.example)');
  if (!isHex(privateKey) || privateKey.length !== 66) throw new Error('AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');

  const sessionRaw = env.AGENT_SESSION_ID;
  if (args.sessionId === null && (sessionRaw === undefined || !/^\d+$/.test(sessionRaw) || BigInt(sessionRaw) === 0n)) {
    throw new Error('AGENT_SESSION_ID must be a positive integer (or pass --session <id>)');
  }
  const sessionId = args.sessionId ?? BigInt(sessionRaw ?? '0');

  const bars = intVar(env, 'AGENT_BARS', 0, 0);
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() || null;
  const openaiApiKey = env.OPENAI_API_KEY?.trim() || null;
  const geminiApiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || null;
  const brain = brainChoice(env, anthropicApiKey, geminiApiKey, openaiApiKey);
  const openaiModel = env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;

  return {
    chainId,
    rpcUrl,
    wsUrl,
    blockbeatAddress: addressVar(env, 'BLOCKBEAT_ADDRESS') ?? blockbeatAddress(chainId) ?? ZERO_ADDRESS,
    privateKey,
    anthropicApiKey,
    model: env.AGENT_MODEL || 'claude-sonnet-5',
    brain,
    openaiApiKey,
    openaiModel,
    openaiReasoningEffort: reasoningEffort(env, openaiModel),
    geminiApiKey,
    geminiModel: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    geminiRpm: intVar(env, 'GEMINI_RPM', DEFAULT_GEMINI_RPM, 0),
    llmTimeoutMs: intVar(env, 'AGENT_LLM_TIMEOUT_MS', brain === 'gemini' ? DEFAULT_GEMINI_TIMEOUT_MS : brain === 'openai' ? DEFAULT_OPENAI_TIMEOUT_MS : DEFAULT_LLM_TIMEOUT_MS, 100),
    enabled: boolVar(env, 'AGENT_ENABLED', true),
    maxHitsPerSession: intVar(env, 'AGENT_MAX_HITS_PER_SESSION', DEFAULT_MAX_HITS_PER_SESSION, 0),
    maxNotesPerBar: notesPerBar(env),
    key: keyVar(env),
    debugLlm: boolVar(env, 'AGENT_DEBUG_LLM', false),
    setStartBar: intVar(env, 'AGENT_SET_START_BAR', 0, 0),
    sessionId,
    bars: bars === 0 ? null : bars,
    identityRegistry: addressVar(env, 'ERC8004_IDENTITY_REGISTRY'),
    statePath: env.AGENT_STATE_PATH || '.agent.json',
    decay: {
      lifetimeBars: parseNoteLifetimeBars(env.NEXT_PUBLIC_NOTE_LIFETIME_BARS),
      maxLivePerTrack: parseMaxLivePerTrack(env.NEXT_PUBLIC_MAX_LIVE_PER_TRACK),
    },
  };
}
