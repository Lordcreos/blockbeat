/**
 * W19: the crowd simulator (`scripts/src/crowd.ts`) as a child of the web server, so the
 * presenter adds simulated players from the host bar. Server only. Mirrors lib/agent/manager.ts
 * with two differences:
 *
 * - The child is ONE node process (`node --import tsx src/crowd.ts …` in scripts/), not pnpm:
 *   on SIGTERM the crowd stops its players and sweeps their MON back to the drip wallet, which
 *   takes a few seconds, and the process that received the signal must be the one sweeping.
 * - Stop does not wait for the exit. It sends SIGTERM to the process group and returns
 *   `stopping: true`; SIGKILL follows only after CROWD_STOP_GRACE_MS (the burner keys are on
 *   disk, so even then `crowd -- --sweep-only` returns the MON). A crowd that is stopping still
 *   counts as running: a second start is refused (CROWD_RUNNING) until it exited.
 *
 * The child's environment is an allowlist: process basics, the stage's chain and decay knobs,
 * and the RPC URLs. It reads the drip key itself from ~/.blockbeat/keys.env; the web server's
 * secrets (DRIP_PRIVATE_KEY, HOST_PRIVATE_KEY, HOST_SECRET, API keys) never reach it.
 * CROWD_MAX_MON (the presenter's budget per run, default the script's 1.5) becomes --max-mon.
 */
import type { Readable } from 'node:stream';

export type CrowdErrorCode = 'CROWD_RUNNING' | 'CROWD_UNAVAILABLE' | 'SPAWN_FAILED' | 'CROWD_MISCONFIGURED';

export class CrowdError extends Error {
  readonly code: CrowdErrorCode;
  constructor(code: CrowdErrorCode, message: string) {
    super(message);
    this.name = 'CrowdError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CrowdChild {
  pid?: number | undefined;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnCrowd = (command: string, args: string[], options: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ['ignore', 'pipe', 'pipe'] }) => CrowdChild;

export type CrowdMode = 'headless' | 'visible';

export interface CrowdStartRequest {
  sessionId: bigint;
  players: number;
  minutes: number;
  mode: CrowdMode;
  /** Join base URL for visible mode (the phones open `${baseUrl}/join/<id>`). */
  baseUrl: string | null;
}

export interface CrowdNumbers {
  bar: number | null;
  bars: number | null;
  playersActive: number | null;
  playersTotal: number | null;
  notesSent: number | null;
  notesConfirmed: number | null;
  onStepPct: number | null;
  monSpent: number | null;
}

export interface CrowdStatus extends CrowdNumbers {
  running: boolean;
  /** SIGTERM sent: the players stopped, the sweep is running. */
  stopping: boolean;
  sessionId: string | null;
  mode: CrowdMode | null;
  players: number | null;
  minutes: number | null;
  pid: number | null;
  startedAt: number | null;
  lines: string[];
  lastExit: string | null;
}

export interface CrowdManager {
  start(request: CrowdStartRequest): CrowdStatus;
  /** SIGTERM now, SIGKILL after the grace period; returns at once. */
  stop(reason: string): Promise<CrowdStatus>;
  stopForSession(sessionId: bigint, reason: string): Promise<CrowdStatus>;
  status(): CrowdStatus;
}

export interface CrowdManagerOptions {
  spawn: SpawnCrowd;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  scriptsRoot: string;
  /** The node binary (process.execPath). */
  nodePath: string;
  available: () => boolean;
  baseEnv: Record<string, string | undefined>;
  log?: (message: string) => void;
  stopGraceMs?: number;
  now?: () => number;
}

export const CROWD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  // Visible mode launches Playwright's browsers.
  'PLAYWRIGHT_BROWSERS_PATH',
  'DISPLAY',
  // The crowd decays notes like the stage it plays on.
  'NEXT_PUBLIC_NOTE_LIFETIME_BARS',
  'NEXT_PUBLIC_MAX_LIVE_PER_TRACK',
] as const;

/** Sweeping 10 burners paced by the reserve rule takes ~10 s on testnet; leave room. */
export const CROWD_STOP_GRACE_MS = 60_000;
const MAX_LINES = 3;
const MAX_LINE_LENGTH = 240;
const PRIVATE_KEY_RE = /0x[0-9a-fA-F]{64}/g;

/** Numbers from a `crowd | bar …` status line or the `crowd summary:` line; empty for other lines. */
export function parseCrowdLine(line: string): Partial<CrowdNumbers> {
  if (!/^crowd (\||summary:)/.test(line)) return {};
  const out: Partial<CrowdNumbers> = {};
  const bar = /\| bar (\d+)\/(\d+) \|/.exec(line);
  const players = /\bplayers (\d+)\/(\d+)\b/.exec(line);
  const sent = /\| sent (\d+)\b/.exec(line);
  const confirmed = /\| confirmed (\d+)\b/.exec(line);
  const onStep = /\| on-step (\d+)%/.exec(line);
  const spent = /\| spent (\d+(?:\.\d+)?) MON/.exec(line);
  if (bar?.[1] && bar[2]) {
    out.bar = Number(bar[1]);
    out.bars = Number(bar[2]);
  }
  if (players?.[1] && players[2]) {
    out.playersActive = Number(players[1]);
    out.playersTotal = Number(players[2]);
  }
  if (sent?.[1]) out.notesSent = Number(sent[1]);
  if (confirmed?.[1]) out.notesConfirmed = Number(confirmed[1]);
  if (onStep?.[1]) out.onStepPct = Number(onStep[1]);
  if (spent?.[1]) out.monSpent = Number(spent[1]);
  return out;
}

function clean(line: string): string {
  const redacted = line.replace(PRIVATE_KEY_RE, '0x…redacted').trimEnd();
  return redacted.length > MAX_LINE_LENGTH ? `${redacted.slice(0, MAX_LINE_LENGTH - 1)}…` : redacted;
}

const EMPTY_NUMBERS: CrowdNumbers = { bar: null, bars: null, playersActive: null, playersTotal: null, notesSent: null, notesConfirmed: null, onStepPct: null, monSpent: null };

interface Run {
  request: CrowdStartRequest;
  pid: number | null;
  startedAt: number;
  stopReason: string | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

export function createCrowdManager(options: CrowdManagerOptions): CrowdManager {
  const log = options.log ?? ((m: string) => console.warn(m));
  const graceMs = options.stopGraceMs ?? CROWD_STOP_GRACE_MS;
  const now = options.now ?? (() => Date.now());

  let run: Run | null = null;
  let lines: string[] = [];
  let numbers: CrowdNumbers = { ...EMPTY_NUMBERS };
  let lastExit: string | null = null;

  function push(line: string): void {
    const text = clean(line);
    if (!text) return;
    lines = [...lines, text].slice(-MAX_LINES);
    numbers = { ...numbers, ...parseCrowdLine(text) };
  }

  function follow(stream: Readable | null): void {
    if (!stream) return;
    let partial = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = (parts.pop() ?? '').slice(0, MAX_LINE_LENGTH + 1);
      for (const part of parts) push(part);
    });
    stream.on('end', () => {
      if (partial) push(partial);
      partial = '';
    });
    stream.on('error', (error: Error) => log(`crowd: output stream error (${error.message})`));
  }

  function status(): CrowdStatus {
    return {
      running: run !== null,
      stopping: run !== null && run.stopReason !== null,
      sessionId: run ? run.request.sessionId.toString() : null,
      mode: run?.request.mode ?? null,
      players: run?.request.players ?? null,
      minutes: run?.request.minutes ?? null,
      pid: run?.pid ?? null,
      startedAt: run?.startedAt ?? null,
      lines: [...lines],
      ...numbers,
      lastExit: run ? null : lastExit,
    };
  }

  function signal(target: Run, sig: NodeJS.Signals): void {
    if (target.pid === null) return;
    try {
      options.kill(target.pid, sig);
    } catch (error) {
      log(`crowd: ${sig} to ${target.pid} failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  function stop(reason: string): Promise<CrowdStatus> {
    const current = run;
    if (!current || current.stopReason !== null) return Promise.resolve(status());
    current.stopReason = reason;
    signal(current, 'SIGTERM');
    current.killTimer = setTimeout(() => {
      if (run !== current) return;
      log(`crowd (session ${current.request.sessionId.toString()}): no exit ${graceMs} ms after SIGTERM; SIGKILL (run crowd -- --sweep-only)`);
      signal(current, 'SIGKILL');
    }, graceMs);
    return Promise.resolve(status());
  }

  return {
    start(request) {
      if (run) throw new CrowdError('CROWD_RUNNING', `a crowd is already ${run.stopReason !== null ? 'stopping (sweeping) in' : 'playing'} session ${run.request.sessionId.toString()}`);
      if (!options.available()) throw new CrowdError('CROWD_UNAVAILABLE', 'scripts/src/crowd.ts was not found next to the web app');
      const env: Record<string, string> = {};
      for (const key of CROWD_ENV_ALLOWLIST) {
        const value = options.baseEnv[key];
        if (value !== undefined) env[key] = value;
      }
      const rpc = options.baseEnv.NEXT_PUBLIC_MONAD_RPC_URL?.trim();
      const ws = options.baseEnv.NEXT_PUBLIC_MONAD_WS_URL?.trim();
      if (rpc) env.MONAD_RPC_URL = rpc;
      if (ws) env.MONAD_WS_URL = ws;
      env.NO_COLOR = '1';
      const args = ['--import', 'tsx', 'src/crowd.ts', '--session', request.sessionId.toString(), '--players', String(request.players), '--minutes', String(request.minutes)];
      const chainId = options.baseEnv.NEXT_PUBLIC_CHAIN_ID?.trim();
      const address = options.baseEnv.NEXT_PUBLIC_BLOCKBEAT_ADDRESS?.trim();
      const maxMon = options.baseEnv.CROWD_MAX_MON?.trim();
      if (maxMon) {
        if (!/^\d+(\.\d{1,18})?$/.test(maxMon)) throw new CrowdError('CROWD_MISCONFIGURED', `CROWD_MAX_MON must be a decimal MON amount, got "${maxMon}"`);
        args.push('--max-mon', maxMon);
      }
      if (chainId) args.push('--chain-id', chainId);
      if (address) args.push('--address', address);
      if (request.mode === 'visible') {
        args.push('--ui');
        if (request.baseUrl) args.push('--base-url', request.baseUrl);
      }
      let child: CrowdChild;
      try {
        child = options.spawn(options.nodePath, args, { cwd: options.scriptsRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        throw new CrowdError('SPAWN_FAILED', `could not start the crowd: ${error instanceof Error ? error.message : String(error)}`);
      }
      lines = [];
      numbers = { ...EMPTY_NUMBERS, playersTotal: request.players };
      lastExit = null;
      const current: Run = { request, pid: child.pid ?? null, startedAt: now(), stopReason: null, killTimer: null };
      run = current;
      const finish = (why: string): void => {
        if (run !== current) return;
        if (current.killTimer !== null) clearTimeout(current.killTimer);
        lastExit = current.stopReason ? `stopped: ${current.stopReason} (${why})` : why;
        log(`crowd (session ${request.sessionId.toString()}): ${lastExit}`);
        run = null;
      };
      follow(child.stdout);
      follow(child.stderr);
      child.on('exit', (code, sig) => finish(code !== null ? `exited with code ${code}` : `killed by ${sig ?? 'a signal'}`));
      child.on('error', (error) => finish(`failed: ${error.message}`));
      return status();
    },
    stop,
    stopForSession(sessionId, reason) {
      if (!run || run.request.sessionId !== sessionId) return Promise.resolve(status());
      return stop(reason);
    },
    status,
  };
}
