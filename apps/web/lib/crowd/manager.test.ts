import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CROWD_STOP_GRACE_MS, CrowdError, createCrowdManager, parseCrowdLine, type CrowdChild, type SpawnCrowd } from './manager';

class FakeChild extends EventEmitter implements CrowdChild {
  pid = 5151;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

const KEY = `0x${'ab'.repeat(32)}`;

function setup(overrides: { available?: boolean; baseEnv?: Record<string, string> } = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn<SpawnCrowd>(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
  const log = vi.fn<(m: string) => void>();
  const manager = createCrowdManager({
    spawn,
    kill,
    log,
    scriptsRoot: '/repo/scripts',
    nodePath: '/usr/local/bin/node',
    available: () => overrides.available ?? true,
    baseEnv: overrides.baseEnv ?? {
      PATH: '/usr/bin',
      HOME: '/home/host',
      DRIP_PRIVATE_KEY: '0xsecret',
      HOST_PRIVATE_KEY: '0xsecret2',
      HOST_SECRET: 'top',
      OPENAI_API_KEY: 'sk-x',
      NEXT_PUBLIC_CHAIN_ID: '10143',
      NEXT_PUBLIC_BLOCKBEAT_ADDRESS: '0x1111111111111111111111111111111111111111',
      NEXT_PUBLIC_MONAD_RPC_URL: 'https://testnet-rpc.monad.xyz',
      NEXT_PUBLIC_MONAD_WS_URL: 'wss://testnet-rpc.monad.xyz',
      NEXT_PUBLIC_NOTE_LIFETIME_BARS: '8',
    },
  });
  return { manager, spawn, kill, log, children, get child(): FakeChild { const c = children.at(-1); if (!c) throw new Error('no child'); return c; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('parseCrowdLine (W19)', () => {
  it('reads players, notes, on-step and MON spent from a status line and the summary', () => {
    expect(parseCrowdLine('crowd | bar 7/25 | players 8/10 | sent 34 | confirmed 31 | on-step 87% | spent 0.4120 MON')).toEqual({ bar: 7, bars: 25, playersActive: 8, playersTotal: 10, notesSent: 34, notesConfirmed: 31, onStepPct: 87, monSpent: 0.412 });
    expect(parseCrowdLine('crowd summary: players 9/10 | sent 90 | confirmed 88 | on-step 91% | p50 300 ms | p95 900 ms | spent 1.0200 MON | swept 0.9 MON')).toMatchObject({ playersActive: 9, notesSent: 90, notesConfirmed: 88, onStepPct: 91, monSpent: 1.02 });
    expect(parseCrowdLine('keys: 10 burners saved')).toEqual({});
  });
});

describe('createCrowdManager (W19)', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('spawns one node process (tsx loader) in scripts/ with only allowlisted env: no drip, host or LLM secrets', () => {
    const s = setup();
    const status = s.manager.start({ sessionId: 12n, players: 10, minutes: 3, mode: 'headless', baseUrl: null });
    expect(status).toMatchObject({ running: true, stopping: false, sessionId: '12', mode: 'headless', players: 10, pid: 5151 });
    const [command, args, options] = s.spawn.mock.calls[0] ?? [];
    expect(command).toBe('/usr/local/bin/node');
    expect(args).toEqual(['--import', 'tsx', 'src/crowd.ts', '--session', '12', '--players', '10', '--minutes', '3', '--chain-id', '10143', '--address', '0x1111111111111111111111111111111111111111']);
    expect(options?.cwd).toBe('/repo/scripts');
    expect(options?.detached).toBe(true);
    expect(options?.env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/host', MONAD_RPC_URL: 'https://testnet-rpc.monad.xyz', MONAD_WS_URL: 'wss://testnet-rpc.monad.xyz', NEXT_PUBLIC_NOTE_LIFETIME_BARS: '8', NO_COLOR: '1' });
    for (const secret of ['DRIP_PRIVATE_KEY', 'HOST_PRIVATE_KEY', 'HOST_SECRET', 'OPENAI_API_KEY']) expect(options?.env).not.toHaveProperty(secret);
  });

  it('passes the presenter budget CROWD_MAX_MON as --max-mon, and refuses a malformed one', () => {
    const s = setup({ baseEnv: { PATH: '/usr/bin', CROWD_MAX_MON: '1.0' } });
    s.manager.start({ sessionId: 12n, players: 10, minutes: 2, mode: 'headless', baseUrl: null });
    const args = s.spawn.mock.calls[0]?.[1] ?? [];
    expect(args.slice(args.indexOf('--max-mon'), args.indexOf('--max-mon') + 2)).toEqual(['--max-mon', '1.0']);
    expect(s.spawn.mock.calls[0]?.[2]?.env).not.toHaveProperty('CROWD_MAX_MON');
    const bad = setup({ baseEnv: { PATH: '/usr/bin', CROWD_MAX_MON: '1; rm -rf /' } });
    expect(() => bad.manager.start({ sessionId: 12n, players: 10, minutes: 2, mode: 'headless', baseUrl: null })).toThrow(/CROWD_MAX_MON/);
    expect(bad.spawn).not.toHaveBeenCalled();
  });

  it('visible mode passes --ui and the join base URL', () => {
    const s = setup();
    s.manager.start({ sessionId: 12n, players: 5, minutes: 2, mode: 'visible', baseUrl: 'https://abc.trycloudflare.com' });
    const args = s.spawn.mock.calls[0]?.[1] ?? [];
    expect(args).toContain('--ui');
    expect(args.slice(args.indexOf('--base-url'), args.indexOf('--base-url') + 2)).toEqual(['--base-url', 'https://abc.trycloudflare.com']);
  });

  it('refuses a second start while one runs, and while it is still stopping (sweeping)', async () => {
    const s = setup();
    s.manager.start({ sessionId: 12n, players: 10, minutes: 3, mode: 'headless', baseUrl: null });
    expect(() => s.manager.start({ sessionId: 13n, players: 10, minutes: 3, mode: 'headless', baseUrl: null })).toThrow(CrowdError);
    const stopped = await s.manager.stop('host pressed Stop crowd');
    expect(stopped).toMatchObject({ running: true, stopping: true });
    try {
      s.manager.start({ sessionId: 13n, players: 10, minutes: 3, mode: 'headless', baseUrl: null });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CrowdError);
      expect((error as CrowdError).code).toBe('CROWD_RUNNING');
    }
    s.child.exit(0);
    expect(s.manager.status()).toMatchObject({ running: false, stopping: false, lastExit: 'stopped: host pressed Stop crowd (exited with code 0)' });
    expect(() => s.manager.start({ sessionId: 13n, players: 10, minutes: 3, mode: 'headless', baseUrl: null })).not.toThrow();
  });

  it('answers 503-style when scripts/ is missing', () => {
    const s = setup({ available: false });
    expect(() => s.manager.start({ sessionId: 1n, players: 1, minutes: 1, mode: 'headless', baseUrl: null })).toThrow(/scripts/);
  });

  it('stop sends SIGTERM to the process group at once (the child sweeps), then SIGKILL after the grace period', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.manager.start({ sessionId: 12n, players: 10, minutes: 3, mode: 'headless', baseUrl: null });
    await s.manager.stop('host pressed Stop crowd');
    expect(s.kill).toHaveBeenCalledWith(5151, 'SIGTERM');
    expect(s.kill).not.toHaveBeenCalledWith(5151, 'SIGKILL');
    vi.advanceTimersByTime(CROWD_STOP_GRACE_MS + 1);
    expect(s.kill).toHaveBeenCalledWith(5151, 'SIGKILL');
    // A second stop does not signal again.
    s.kill.mockClear();
    await s.manager.stop('again');
    expect(s.kill).not.toHaveBeenCalled();
  });

  it('stopForSession only stops the crowd of that session (finalize)', async () => {
    const s = setup();
    s.manager.start({ sessionId: 12n, players: 10, minutes: 3, mode: 'headless', baseUrl: null });
    await s.manager.stopForSession(13n, 'session finalized');
    expect(s.kill).not.toHaveBeenCalled();
    await s.manager.stopForSession(12n, 'session finalized');
    expect(s.kill).toHaveBeenCalledWith(5151, 'SIGTERM');
  });

  it('keeps the last three lines with keys redacted, and the latest numbers', async () => {
    const s = setup();
    s.manager.start({ sessionId: 12n, players: 10, minutes: 3, mode: 'headless', baseUrl: null });
    s.child.stdout.write(`leaked ${KEY}\n`);
    s.child.stdout.write('crowd | bar 1/25 | players 3/10 | sent 4 | confirmed 2 | on-step 50% | spent 0.0510 MON\n');
    s.child.stderr.write('warn: heads reconnect\n');
    s.child.stdout.write('crowd | bar 2/25 | players 5/10 | sent 9 | confirmed 8 | on-step 75% | spent 0.1020 MON\n');
    await tick();
    const status = s.manager.status();
    expect(status.lines).toHaveLength(3);
    expect(status.lines.join('\n')).not.toContain(KEY);
    expect(status).toMatchObject({ playersActive: 5, playersTotal: 10, notesSent: 9, notesConfirmed: 8, onStepPct: 75, monSpent: 0.102, bar: 2, bars: 25 });
  });

  it('records why the run ended and forgets the child', () => {
    const s = setup();
    s.manager.start({ sessionId: 12n, players: 10, minutes: 3, mode: 'headless', baseUrl: null });
    s.child.exit(3);
    expect(s.manager.status()).toMatchObject({ running: false, lastExit: 'exited with code 3' });
    s.manager.start({ sessionId: 12n, players: 10, minutes: 3, mode: 'headless', baseUrl: null });
    s.child.emit('error', new Error('spawn ENOENT'));
    expect(s.manager.status()).toMatchObject({ running: false, lastExit: 'failed: spawn ENOENT' });
  });
});
