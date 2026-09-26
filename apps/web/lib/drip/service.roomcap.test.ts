import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { DEFAULT_MAX_PLAYERS_PER_SESSION, DripError, DripRevertedError, createDripService, dripLimitsFromEnv, type DripSender } from './service';

const TX = `0x${'cd'.repeat(32)}` as Hash;
const addr = (i: number): `0x${string}` => `0x${i.toString(16).padStart(40, '0')}`;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (error) {
    return error instanceof DripError ? `${error.code}:${error.status}` : String(error);
  }
}

describe('drip: players per session (W19, DRIP_MAX_PLAYERS_PER_SESSION)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('defaults to 20 and reads the env (0 turns the cap off)', () => {
    expect(DEFAULT_MAX_PLAYERS_PER_SESSION).toBe(20);
    expect(dripLimitsFromEnv({}).maxPlayersPerSession).toBe(20);
    expect(dripLimitsFromEnv({ DRIP_MAX_PLAYERS_PER_SESSION: '3' }).maxPlayersPerSession).toBe(3);
    expect(dripLimitsFromEnv({ DRIP_MAX_PLAYERS_PER_SESSION: '0' }).maxPlayersPerSession).toBe(0);
    expect(() => dripLimitsFromEnv({ DRIP_MAX_PLAYERS_PER_SESSION: 'many' })).toThrow(/DRIP_MAX_PLAYERS_PER_SESSION/);
  });

  it('funds distinct players up to the cap, then answers 409 ROOM_FULL without sending', async () => {
    const send = vi.fn(async () => TX);
    const drip = createDripService({ sender: { send }, maxPlayersPerSession: 2 });
    await drip.drip({ address: addr(1), ip: 'a', sessionId: '7' });
    await drip.drip({ address: addr(2), ip: 'b', sessionId: '7' });
    expect(await code(drip.drip({ address: addr(3), ip: 'c', sessionId: '7' }))).toBe('ROOM_FULL:409');
    expect(send).toHaveBeenCalledTimes(2);
    // Asking again for a player already in the room is not a new player.
    expect(await drip.drip({ address: addr(1), ip: 'a', sessionId: '7' })).toMatchObject({ alreadyFunded: true });
    // Another session has its own room.
    await drip.drip({ address: addr(4), ip: 'd', sessionId: '8' });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('top-ups do not count as players', async () => {
    const send = vi.fn(async () => TX);
    const drip = createDripService({ sender: { send }, maxPlayersPerSession: 1, balanceOf: async () => 0n });
    await drip.drip({ address: addr(1), ip: 'a', sessionId: '7' });
    await drip.drip({ address: addr(1), ip: 'a', sessionId: '7', topUp: true });
    expect(await code(drip.drip({ address: addr(2), ip: 'b', sessionId: '7' }))).toBe('ROOM_FULL:409');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a failed send or a reverted drip gives the seat back; a request without a session shares one capped room', async () => {
    let fail = true;
    const confirm = vi.fn<NonNullable<DripSender['confirm']>>(async () => undefined);
    const send = vi.fn(async () => {
      if (fail) throw new Error('rpc down');
      return TX;
    });
    const drip = createDripService({ sender: { send, confirm }, maxPlayersPerSession: 1, log: () => undefined });
    expect(await code(drip.drip({ address: addr(1), ip: 'a', sessionId: '7' }))).toBe('DRIP_FAILED:502');
    fail = false;
    confirm.mockRejectedValueOnce(new DripRevertedError(TX));
    await drip.drip({ address: addr(2), ip: 'b', sessionId: '7' });
    await vi.runAllTimersAsync();
    await drip.drip({ address: addr(3), ip: 'c', sessionId: '7' });
    expect(await code(drip.drip({ address: addr(4), ip: 'd', sessionId: '7' }))).toBe('ROOM_FULL:409');
    await drip.drip({ address: addr(5), ip: 'e' });
    expect(await code(drip.drip({ address: addr(6), ip: 'f' }))).toBe('ROOM_FULL:409');
  });

  it('two requests racing for the last seat: one is funded, the other is refused', async () => {
    const send = vi.fn(async () => TX);
    const drip = createDripService({ sender: { send }, maxPlayersPerSession: 1 });
    const results = await Promise.all([code(drip.drip({ address: addr(1), ip: 'a', sessionId: '7' })), code(drip.drip({ address: addr(2), ip: 'b', sessionId: '7' }))]);
    expect(results.sort()).toEqual(['ROOM_FULL:409', 'ok']);
  });

  it('with the cap off, anyone is funded', async () => {
    const send = vi.fn(async () => TX);
    const drip = createDripService({ sender: { send }, maxPlayersPerSession: 0 });
    for (let i = 1; i <= 5; i++) await drip.drip({ address: addr(i), ip: `ip${i}`, sessionId: '7' });
    expect(send).toHaveBeenCalledTimes(5);
  });
});
