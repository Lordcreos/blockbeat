import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { MAX_LIVE_PER_TRACK, MONAD_TESTNET_ID, NOTE_LIFETIME_BARS, blockbeatAddress } from '@blockbeat/shared';
import { parseCrowdArgs } from '../../src/lib/crowd/args';

describe('parseCrowdArgs (W19)', () => {
  it('applies the defaults: 10 players, 3 minutes, 1.5 MON budget, testnet', () => {
    const o = parseCrowdArgs(['--', '--session', '12'], {}, () => 99);
    expect(o.mode).toBe('play');
    if (o.mode !== 'play') return;
    expect(o.sessionId).toBe(12n);
    expect(o.players).toBe(10);
    expect(o.minutes).toBe(3);
    expect(o.maxWei).toBe(parseEther('1.5'));
    expect(o.seed).toBe(99);
    expect(o.chainId).toBe(MONAD_TESTNET_ID);
    expect(o.address).toBe(blockbeatAddress(MONAD_TESTNET_ID));
    expect(o.blockMs).toBe(300);
    expect(o.rps).toBe(15);
    expect(o.notesPerPlayer).toBeNull();
    expect(o.lifetimeBars).toBe(NOTE_LIFETIME_BARS);
    expect(o.maxLivePerTrack).toBe(MAX_LIVE_PER_TRACK);
  });

  it('reads the flags and the decay knobs the stage uses', () => {
    const o = parseCrowdArgs(['--session', '3', '--players', '4', '--minutes', '0.5', '--max-mon', '0.25', '--seed', '7', '--notes-per-player', '5'], { NEXT_PUBLIC_NOTE_LIFETIME_BARS: '4', NEXT_PUBLIC_MAX_LIVE_PER_TRACK: '0' });
    expect(o).toMatchObject({ mode: 'play', sessionId: 3n, players: 4, minutes: 0.5, maxWei: parseEther('0.25'), seed: 7, notesPerPlayer: 5, lifetimeBars: 4, maxLivePerTrack: 0 });
  });

  it('refuses a missing or bad session, and out-of-range numbers', () => {
    expect(() => parseCrowdArgs([], {})).toThrow(/--session/);
    expect(() => parseCrowdArgs(['--session', '0'], {})).toThrow(/--session/);
    expect(() => parseCrowdArgs(['--session', '1', '--players', '0'], {})).toThrow(/--players/);
    expect(() => parseCrowdArgs(['--session', '1', '--players', '31'], {})).toThrow(/--players/);
    expect(() => parseCrowdArgs(['--session', '1', '--minutes', '0'], {})).toThrow(/--minutes/);
    expect(() => parseCrowdArgs(['--session', '1', '--minutes', '16'], {})).toThrow(/--minutes/);
    expect(() => parseCrowdArgs(['--session', '1', '--max-mon', 'lots'], {})).toThrow(/--max-mon/);
    expect(() => parseCrowdArgs(['--session', '1', '--max-mon', '6'], {})).toThrow(/--max-mon/);
    expect(() => parseCrowdArgs(['--session', '1', '--rps', '51'], {})).toThrow(/--rps/);
    expect(() => parseCrowdArgs(['--session', '1', '--bogus'], {})).toThrow(/unknown flag --bogus/);
  });

  it('--ui: visible phones (default 5, at most 6), an optional --base-url that must be http(s)', () => {
    const o = parseCrowdArgs(['--session', '3', '--ui'], {});
    expect(o).toMatchObject({ mode: 'play', ui: { baseUrl: null, snapshotAtBar: null, play: 'tap' }, players: 5 });
    expect(parseCrowdArgs(['--session', '3', '--ui', '--play', 'aim'], {})).toMatchObject({ ui: { play: 'aim' } });
    expect(() => parseCrowdArgs(['--session', '3', '--ui', '--play', 'mash'], {})).toThrow(/--play/);
    expect(parseCrowdArgs(['--session', '3', '--ui', '--snapshot-bar', '6'], {})).toMatchObject({ ui: { snapshotAtBar: 6 } });
    const p = parseCrowdArgs(['--session', '3', '--ui', '--players', '3', '--base-url', 'https://abc.trycloudflare.com/'], {});
    expect(p).toMatchObject({ ui: { baseUrl: 'https://abc.trycloudflare.com' }, players: 3 });
    expect(() => parseCrowdArgs(['--session', '3', '--ui', '--players', '7'], {})).toThrow(/--players/);
    expect(() => parseCrowdArgs(['--session', '3', '--ui', '--base-url', 'javascript:alert(1)'], {})).toThrow(/--base-url/);
    expect(parseCrowdArgs(['--session', '3'], {})).toMatchObject({ ui: null, players: 10 });
  });

  it('--sweep-only needs no session', () => {
    const o = parseCrowdArgs(['--sweep-only'], {});
    expect(o.mode).toBe('sweep-only');
  });
});
