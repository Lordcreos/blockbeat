/**
 * W12: the resident DJ agent as a child process of the web server, so the presenter starts
 * and stops it from the stage instead of a second terminal. Server only.
 *
 * The child is `pnpm --filter agent start` in the repo root with AGENT_SESSION_ID set and
 * AGENT_BARS empty (unbounded). Its environment is an allowlist of process basics plus those
 * two: the agent reads its own key and settings from apps/agent/.env (dotenv in its cwd), and
 * the web server's keys (DRIP_PRIVATE_KEY, HOST_PRIVATE_KEY, HOST_SECRET) never reach it.
 * It runs in its own process group so a stop reaches pnpm, tsx and node together: SIGTERM
 * (the agent lets in-flight hits settle, up to 5 s), then SIGKILL after the grace period.
 * One agent at a time; a second start is refused (AGENT_RUNNING).
 */
import type { Readable } from 'node:stream';

export type AgentErrorCode = 'AGENT_RUNNING' | 'AGENT_UNAVAILABLE' | 'SPAWN_FAILED';

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The parts of a ChildProcess the manager uses (a real one satisfies it). */
export interface AgentChild {
  pid?: number | undefined;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnAgent = (command: string, args: string[], options: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ['ignore', 'pipe', 'pipe'] }) => AgentChild;

export interface AgentStatus {
  running: boolean;
  sessionId: string | null;
  pid: number | null;
  startedAt: number | null;
  /** Last three output lines (stdout and stderr), newest last. */
  lines: string[];
  /** From the latest status line; null until the first bar. */
  hitsSent: number | null;
  budgetLeft: number | null;
  brain: string | null;
  /** Why the previous run ended; null while it runs or before any run. */
  lastExit: string | null;
}

export interface AgentManager {
  start(sessionId: bigint): AgentStatus;
  /** SIGTERM, then SIGKILL after the grace period; resolves once the child exited (or at once when idle). */
  stop(reason: string): Promise<AgentStatus>;
  /** Review H4: stop the agent only when it plays this session (finalize). */
  stopForSession(sessionId: bigint, reason: string): Promise<AgentStatus>;
  status(): AgentStatus;
}

export interface AgentManagerOptions {
  spawn: SpawnAgent;
  /** Signals the child's process group. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  repoRoot: string;
  /** True when apps/agent exists under repoRoot. */
  agentAvailable: () => boolean;
  /** The web server's environment; only ENV_ALLOWLIST keys are passed on. */
  baseEnv: Record<string, string | undefined>;
  log?: (message: string) => void;
  stopGraceMs?: number;
  now?: () => number;
}

/** Process basics pnpm and node need; nothing that could carry a web secret. */
export const ENV_ALLOWLIST = [
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
  'PNPM_HOME',
  'COREPACK_HOME',
  'NVM_DIR',
  'NVM_BIN',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  // W13: the DJ must decay notes exactly like the stage it plays on (same knobs, same shared rule).
  'NEXT_PUBLIC_NOTE_LIFETIME_BARS',
  'NEXT_PUBLIC_MAX_LIVE_PER_TRACK',
] as const;

const MAX_LINES = 3;
const MAX_LINE_LENGTH = 240;
export const AGENT_STOP_GRACE_MS = 7_000;
const PRIVATE_KEY_RE = /0x[0-9a-fA-F]{64}/g;

/** Hits sent, budget left and brain from a status or summary line; empty for other lines. */
export function parseAgentLine(line: string): { sent?: number; budgetLeft?: number; brain?: string } {
  const out: { sent?: number; budgetLeft?: number; brain?: string } = {};
  const sent = /\|\s*sent (\d+)\s*\|/.exec(line) ?? /summary:.*?\bsent (\d+)\b/.exec(line);
  const budget = /\|\s*budget(?: left)? (\d+)\s*\|/.exec(line);
  // W14: "gemini gemini-3.8-flash" or "rules (gemini timeout)"; a short, fixed-alphabet label only.
  const brain = /\|\s*brain ([a-z][a-z0-9-]*(?: [A-Za-z0-9][A-Za-z0-9._:/-]{0,63})?(?: \([a-z0-9 :-]{1,48}\))?)\s*(?:\||$)/.exec(line);
  if (sent?.[1]) out.sent = Number(sent[1]);
  if (budget?.[1]) out.budgetLeft = Number(budget[1]);
  if (brain?.[1]) out.brain = brain[1];
  return out;
}

/** W14 backstop: provider API key shapes (Google "AIza…", OpenAI / Anthropic "sk-…"); the agent redacts them too. */
const API_KEY_RES: ReadonlyArray<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…redacted'],
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-…redacted'],
];

function clean(line: string): string {
  const redacted = API_KEY_RES.reduce((acc, [re, r]) => acc.replace(re, r), line.replace(PRIVATE_KEY_RE, '0x…redacted')).trimEnd();
  return redacted.length > MAX_LINE_LENGTH ? `${redacted.slice(0, MAX_LINE_LENGTH - 1)}…` : redacted;
}

interface Run {
  child: AgentChild;
  sessionId: bigint;
  pid: number | null;
  startedAt: number;
  exited: Promise<void>;
  stopReason: string | null;
}

export function createAgentManager(options: AgentManagerOptions): AgentManager {
  const log = options.log ?? ((m: string) => console.warn(m));
  const graceMs = options.stopGraceMs ?? AGENT_STOP_GRACE_MS;
  const now = options.now ?? (() => Date.now());

  let run: Run | null = null;
  let lines: string[] = [];
  let hitsSent: number | null = null;
  let budgetLeft: number | null = null;
  let brain: string | null = null;
  let lastExit: string | null = null;

  function push(line: string): void {
    const text = clean(line);
    if (!text) return;
    lines = [...lines, text].slice(-MAX_LINES);
    const parsed = parseAgentLine(text);
    if (parsed.sent !== undefined) hitsSent = parsed.sent;
    if (parsed.budgetLeft !== undefined) budgetLeft = parsed.budgetLeft;
    if (parsed.brain !== undefined) brain = parsed.brain;
  }

  function follow(stream: Readable | null): void {
    if (!stream) return;
    let partial = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const parts = (partial + chunk).split(/\r?\n/);
      // A line longer than this is truncated by clean() anyway; never buffer more than that.
      partial = (parts.pop() ?? '').slice(0, MAX_LINE_LENGTH + 1);
      for (const part of parts) push(part);
    });
    stream.on('end', () => {
      if (partial) push(partial);
      partial = '';
    });
    // Without a listener a pipe error (EPIPE while the child dies) would throw in the server.
    stream.on('error', (error: Error) => log(`agent: output stream error (${error.message})`));
  }

  function status(): AgentStatus {
    return {
      running: run !== null,
      sessionId: run ? run.sessionId.toString() : null,
      pid: run?.pid ?? null,
      startedAt: run?.startedAt ?? null,
      lines: [...lines],
      hitsSent,
      budgetLeft,
      brain,
      lastExit: run ? null : lastExit,
    };
  }

  function signal(target: Run, sig: NodeJS.Signals): void {
    if (target.pid === null) return;
    try {
      options.kill(target.pid, sig);
    } catch (error) {
      // ESRCH: the group is already gone; anything else is worth a line in the server log.
      log(`agent: ${sig} to ${target.pid} failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  async function stop(reason: string): Promise<AgentStatus> {
    const current = run;
    if (!current) return status();
    current.stopReason = reason;
    signal(current, 'SIGTERM');
    const waitExit = async (ms: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      });
      const exited = await Promise.race([current.exited.then(() => true as const), timeout]);
      if (timer !== null) clearTimeout(timer);
      return exited;
    };
    if (!(await waitExit(graceMs)) && run === current) {
      signal(current, 'SIGKILL');
      if (!(await waitExit(graceMs)) && run === current) {
        // Never leave the stage stuck on "running": forget the child and say so.
        lastExit = `stopped: ${reason} (no exit seen after SIGKILL)`;
        log(`agent (session ${current.sessionId.toString()}): ${lastExit}`);
        run = null;
      }
    }
    return status();
  }

  return {
    start(sessionId) {
      if (run) throw new AgentError('AGENT_RUNNING', `the DJ is already playing session ${run.sessionId.toString()}`);
      if (!options.agentAvailable()) throw new AgentError('AGENT_UNAVAILABLE', 'apps/agent was not found next to the web app');
      const env: Record<string, string> = {};
      for (const key of ENV_ALLOWLIST) {
        const value = options.baseEnv[key];
        if (value !== undefined) env[key] = value;
      }
      env.AGENT_SESSION_ID = sessionId.toString();
      env.AGENT_BARS = '';
      env.NO_COLOR = '1';
      let child: AgentChild;
      try {
        child = options.spawn('pnpm', ['--filter', 'agent', 'start'], { cwd: options.repoRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        throw new AgentError('SPAWN_FAILED', `could not start the agent: ${error instanceof Error ? error.message : String(error)}`);
      }
      lines = [];
      hitsSent = null;
      budgetLeft = null;
      brain = null;
      lastExit = null;
      let markExited: () => void = () => undefined;
      const current: Run = {
        child,
        sessionId,
        pid: child.pid ?? null,
        startedAt: now(),
        exited: new Promise<void>((resolve) => (markExited = resolve)),
        stopReason: null,
      };
      run = current;
      const finish = (why: string): void => {
        if (run !== current) return;
        lastExit = current.stopReason ? `stopped: ${current.stopReason} (${why})` : why;
        log(`agent (session ${sessionId.toString()}): ${lastExit}`);
        run = null;
        markExited();
      };
      follow(child.stdout);
      follow(child.stderr);
      child.on('exit', (code, sig) => finish(code !== null ? `exited with code ${code}` : `killed by ${sig ?? 'a signal'}`));
      child.on('error', (error) => finish(`failed: ${error.message}`));
      return status();
    },

    stop,

    async stopForSession(sessionId, reason) {
      if (!run || run.sessionId !== sessionId) return status();
      return stop(reason);
    },

    status,
  };
}
