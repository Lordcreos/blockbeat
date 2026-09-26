import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError, createAgentManager, parseAgentLine, type AgentChild, type SpawnAgent } from './manager';

class FakeChild extends EventEmitter implements AgentChild {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

function setup(overrides: { root?: string; exists?: boolean; baseEnv?: Record<string, string> } = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn<SpawnAgent>(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
  const log = vi.fn<(m: string) => void>();
  const manager = createAgentManager({
    spawn,
    kill,
    log,
    repoRoot: overrides.root ?? '/repo',
    agentAvailable: () => overrides.exists ?? true,
    baseEnv: overrides.baseEnv ?? { PATH: '/usr/bin', HOME: '/home/dj', DRIP_PRIVATE_KEY: '0xsecret', HOST_PRIVATE_KEY: '0xsecret2', HOST_SECRET: 'top' },
    stopGraceMs: 6_000,
  });
  return { manager, spawn, kill, log, children, get child() { const c = children.at(-1); if (!c) throw new Error('no child'); return c; } };
}

const STATUS = '14:02:11.123 bar 214 | block 65518906 | sent 3 | match 1/2 (50%) | budget 37 | brain openai | clock ws 329ms | erc8004 unregistered | next: no additions';

describe('parseAgentLine (W12)', () => {
  it('reads hits sent, budget left and the brain from a status line', () => {
    expect(parseAgentLine(STATUS)).toEqual({ sent: 3, budgetLeft: 37, brain: 'openai' });
  });
  it('reads the summary line too', () => {
    expect(parseAgentLine('summary: bars 3 | sent 6 | confirmed 6 | matched 1 (17%) | failed 0 | skipped 3 | cancelled 0 | gas 700000 | budget left 2 | brain rules | erc8004 unregistered')).toEqual({ sent: 6, budgetLeft: 2, brain: 'rules' });
  });
  it('reads the W14 brain label: provider and model, or rules with the fallback class', () => {
    expect(parseAgentLine('bar 3 | block 9 | sent 1 | match 0/0 (-) | budget 39 | brain gemini gemini-3.8-flash | clock ws 300ms | next: no additions').brain).toBe('gemini gemini-3.8-flash');
    expect(parseAgentLine('bar 4 | block 9 | sent 1 | match 0/0 (-) | budget 39 | brain rules (gemini timeout) | clock ws 300ms').brain).toBe('rules (gemini timeout)');
    expect(parseAgentLine('bar 5 | sent 1 | budget 39 | brain rules (gemini http 429)').brain).toBe('rules (gemini http 429)');
    expect(parseAgentLine('summary: bars 4 | sent 6 | budget left 2 | brain gemini models/gemini-2.5-flash | erc8004 unregistered').brain).toBe('gemini models/gemini-2.5-flash');
    expect(parseAgentLine('bar 6 | sent 1 | budget 39 | brain openai GPT_6:mini-2026 | clock ws').brain).toBe('openai GPT_6:mini-2026');
    expect(parseAgentLine('bar 7 | sent 1 | budget 39 | brain rules (gemini unavailable: model not found) | clock ws').brain).toBe('rules (gemini unavailable: model not found)');
  });
  it('ignores a brain field that is not a short label (never shows arbitrary text)', () => {
    expect(parseAgentLine('bar 5 | sent 1 | budget 39 | brain gemini <script>x</script> | clock ws').brain).toBeUndefined();
    expect(parseAgentLine(`bar 5 | sent 1 | budget 39 | brain gemini ${'x'.repeat(80)} | clock ws`).brain).toBeUndefined();
  });
  it('returns nothing for other lines', () => {
    expect(parseAgentLine('agent 0xabc on chain 10143')).toEqual({});
  });
});

describe('createAgentManager (W12)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('spawns `pnpm --filter agent start` in the repo root for the session, unbounded, without the web server secrets', () => {
    const t = setup();
    const status = t.manager.start(3n);
    expect(status).toMatchObject({ running: true, sessionId: '3', pid: 4242 });
    const [command, args, options] = t.spawn.mock.calls[0] ?? [];
    expect(command).toBe('pnpm');
    expect(args).toEqual(['--filter', 'agent', 'start']);
    expect(options?.cwd).toBe('/repo');
    expect(options?.detached).toBe(true);
    expect(options?.env.AGENT_SESSION_ID).toBe('3');
    expect(options?.env.AGENT_BARS).toBe('');
    expect(options?.env.PATH).toBe('/usr/bin');
    // apps/agent/.env is loaded by the agent itself (dotenv in its cwd); the web keys never reach it.
    expect(options?.env).not.toHaveProperty('DRIP_PRIVATE_KEY');
    expect(options?.env).not.toHaveProperty('HOST_PRIVATE_KEY');
    expect(options?.env).not.toHaveProperty('HOST_SECRET');
  });

  it('W13: passes the decay knobs so the DJ decays notes like the stage', () => {
    const t = setup({ baseEnv: { PATH: '/usr/bin', NEXT_PUBLIC_NOTE_LIFETIME_BARS: '4', NEXT_PUBLIC_MAX_LIVE_PER_TRACK: '0', HOST_SECRET: 'top' } });
    t.manager.start(3n);
    const [, , options] = t.spawn.mock.calls[0] ?? [];
    expect(options?.env.NEXT_PUBLIC_NOTE_LIFETIME_BARS).toBe('4');
    expect(options?.env.NEXT_PUBLIC_MAX_LIVE_PER_TRACK).toBe('0');
    expect(options?.env).not.toHaveProperty('HOST_SECRET');
  });

  it('refuses to start twice', () => {
    const t = setup();
    t.manager.start(3n);
    expect(() => t.manager.start(3n)).toThrow(AgentError);
    expect(() => t.manager.start(4n)).toThrow(expect.objectContaining({ code: 'AGENT_RUNNING' }));
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses when apps/agent is not next to the web app', () => {
    const t = setup({ exists: false });
    expect(() => t.manager.start(3n)).toThrow(expect.objectContaining({ code: 'AGENT_UNAVAILABLE' }));
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it('keeps the last three output lines and the parsed counters', () => {
    const t = setup();
    t.manager.start(3n);
    t.child.stdout.write('agent 0xabc on chain 10143\ncontract 0xf18 session 3\n');
    t.child.stdout.write(STATUS.slice(0, 40));
    t.child.stdout.write(`${STATUS.slice(40)}\n`);
    t.child.stderr.write('14:02:12.000 WARN brain: openai failed (timeout); using rules for this bar\n');
    const s = t.manager.status();
    expect(s.lines).toEqual([
      'contract 0xf18 session 3',
      STATUS,
      '14:02:12.000 WARN brain: openai failed (timeout); using rules for this bar',
    ]);
    expect(s).toMatchObject({ hitsSent: 3, budgetLeft: 37, brain: 'openai' });
  });

  it('truncates very long lines and redacts anything that looks like a private key', () => {
    const t = setup();
    t.manager.start(3n);
    t.child.stdout.write(`oops 0x${'ab'.repeat(32)} ${'x'.repeat(400)}\n`);
    const [line] = t.manager.status().lines;
    expect(line).not.toContain('ab'.repeat(32));
    expect(line).toContain('0x…redacted');
    expect(line?.length).toBeLessThanOrEqual(240);
  });

  it('W14: redacts anything shaped like a provider API key before it reaches the stage', () => {
    const t = setup();
    t.manager.start(3n);
    const google = `AIza${'Sy0123456789abcdefghijklmnopqrstu'}`;
    t.child.stderr.write(`WARN brain: gemini failed (gemini 400: key ${google} bad; sk-proj-abcdefghijklmnop1234)\n`);
    const [line] = t.manager.status().lines;
    expect(line).not.toContain(google);
    expect(line).not.toContain('sk-proj-');
    expect(line).toContain('AIza…redacted');
  });

  it('logs a stdout/stderr stream error instead of crashing the web server (review)', () => {
    const t = setup();
    t.manager.start(3n);
    expect(() => t.child.stdout.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(() => t.child.stderr.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('EPIPE'));
  });

  it('caps a partial line that never ends so a newline-less burst cannot grow memory (review)', () => {
    const t = setup();
    t.manager.start(3n);
    for (let i = 0; i < 50; i++) t.child.stdout.write('y'.repeat(10_000));
    t.child.stdout.write('\n');
    const [line] = t.manager.status().lines;
    expect(line?.length).toBeLessThanOrEqual(240);
  });

  it('stops with SIGTERM to the process group, then SIGKILL after the grace period', async () => {
    const t = setup();
    t.manager.start(3n);
    const stopping = t.manager.stop('host pressed Stop DJ');
    expect(t.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(t.kill).toHaveBeenCalledWith(4242, 'SIGKILL');
    t.child.exit(null, 'SIGKILL');
    const s = await stopping;
    expect(s.running).toBe(false);
    expect(s.lastExit).toMatch(/host pressed Stop DJ/);
  });

  it('resolves stop as soon as the agent exits on SIGTERM', async () => {
    const t = setup();
    t.manager.start(3n);
    const stopping = t.manager.stop('session finalized');
    t.child.exit(0);
    const s = await stopping;
    expect(s.running).toBe(false);
    expect(t.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.kill).toHaveBeenCalledTimes(1);
  });

  it('forgets a child that ignores even SIGKILL instead of hanging the stage', async () => {
    const t = setup();
    t.manager.start(3n);
    const stopping = t.manager.stop('host pressed Stop DJ');
    await vi.advanceTimersByTimeAsync(12_000);
    const s = await stopping;
    expect(s.running).toBe(false);
    expect(s.lastExit).toMatch(/no exit seen after SIGKILL/);
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('no exit seen'));
  });

  it('stop is a no-op when nothing runs', async () => {
    const t = setup();
    await expect(t.manager.stop('x')).resolves.toMatchObject({ running: false });
    expect(t.kill).not.toHaveBeenCalled();
  });

  it('records an exit by itself (bad config, finalized session) and allows a new start', () => {
    const t = setup();
    t.manager.start(3n);
    t.child.stderr.write('agent: session 3 is finalized\n');
    t.child.exit(1);
    const s = t.manager.status();
    expect(s.running).toBe(false);
    expect(s.lastExit).toBe('exited with code 1');
    expect(s.lines.at(-1)).toBe('agent: session 3 is finalized');
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('exited with code 1'));
    t.manager.start(4n);
    expect(t.manager.status()).toMatchObject({ running: true, sessionId: '4', hitsSent: null, lines: [] });
  });

  it('reports a spawn failure instead of hanging in running', () => {
    const t = setup();
    t.manager.start(3n);
    t.child.emit('error', new Error('spawn pnpm ENOENT'));
    const s = t.manager.status();
    expect(s.running).toBe(false);
    expect(s.lastExit).toMatch(/ENOENT/);
  });

  it('stopForSession only stops the agent of that session (review H4)', async () => {
    const t = setup();
    t.manager.start(3n);
    await t.manager.stopForSession(4n, 'finalize');
    expect(t.kill).not.toHaveBeenCalled();
    const stopping = t.manager.stopForSession(3n, 'session finalized');
    t.child.exit(0);
    await stopping;
    expect(t.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
  });
});
