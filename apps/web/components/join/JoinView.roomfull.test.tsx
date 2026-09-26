import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import type { SessionState } from '@blockbeat/shared';
import type { UseBalanceResult } from '@/lib/hooks';

const session: SessionState = { sessionId: 7n, startBlock: 100n, host: '0x000000000000000000000000000000000000b10c', finalized: false, hitCount: 12n, tokenId: 0n, parentSessionId: 0n, tipPool: 0n };
let balance: UseBalanceResult;
const feed = { session, pattern: [], hitCount: 12, uniquePlayers: 20, hitsPerMinute: 0, avgLatencyMs: null, connected: true, lastHit: null, error: null, hits: [], headHint: null };
const balanceEnabled = vi.fn();

const stable = vi.hoisted(() => ({
  burner: { address: '0x0000000000000000000000000000000000000001' as const, restored: true },
  drip: { drip: null, loading: false, error: 'ROOM_FULL: the room is full: 20 players are already funded in this session', retryInSeconds: null, phase: null, roomFull: true },
  sender: { send: () => Promise.resolve(), pending: 0 },
  tip: { tip: () => Promise.resolve(), pending: false, readyAt: () => null },
  topUp: { phase: null, error: null, topUpsLeft: null, topUp: () => Promise.resolve(false) },
}));

vi.mock('@/lib/hooks', () => ({
  useBurner: () => stable.burner,
  useDrip: () => stable.drip,
  useHitSender: () => stable.sender,
  useTip: () => stable.tip,
  useBalance: (_a: unknown, _s: unknown, enabled: boolean) => {
    balanceEnabled(enabled);
    return balance;
  },
  useTopUp: () => stable.topUp,
  useEventFeed: () => feed,
}));
vi.mock('@/lib/runtime', () => ({
  getRuntime: () => ({
    clock: { getState: () => ({ currentBlock: 0n, currentStep: 0, measuredBlockMs: 300, msSinceHead: 0, source: 'mock' }), onStep: () => () => undefined, onHead: () => () => undefined, predictBlock: () => 0n, start: () => undefined, stop: () => undefined, setStartBlock: () => undefined },
  }),
}));

const { JoinView } = await import('./JoinView');

const refresh = (): void => undefined;
function withBalance(mon: string | null): UseBalanceResult {
  return { balanceWei: mon === null ? null : parseEther(mon), notesLeft: null, level: null, error: null, refresh };
}

describe('JoinView when the room is full (W19)', () => {
  beforeEach(() => {
    window.localStorage.setItem('blockbeat:phone:tour', 'done');
    balanceEnabled.mockReset();
  });
  afterEach(cleanup);

  it('says the room is full instead of a funding error, and offers no pads', () => {
    balance = withBalance('0');
    render(<JoinView sessionId={7n} />);
    expect(screen.getByRole('status', { name: /room is full/i }).textContent).toContain('The room is full: watch the big screen');
    expect(screen.queryByText(/did not get funded/i)).toBeNull();
    expect(screen.queryByTestId('pads')).toBeNull();
  });

  it('with no MON on this phone: just watching, no tip button', () => {
    balance = withBalance('0');
    render(<JoinView sessionId={7n} />);
    expect(screen.queryByRole('button', { name: /tip the room/i })).toBeNull();
    expect(screen.getByText(/you are watching/i)).toBeTruthy();
  });

  it('with MON left from before: Tip the room still works', () => {
    balance = withBalance('0.2');
    render(<JoinView sessionId={7n} />);
    expect(balanceEnabled).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: /tip the room/i }).hasAttribute('disabled')).toBe(false);
  });
});
