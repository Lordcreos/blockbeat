import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import type { HitEvent, SessionState } from '@blockbeat/shared';
import { HitError } from '@/lib/hitSender';
import type { UseBalanceResult, UseTopUpResult } from '@/lib/hooks';

const session: SessionState = {
  sessionId: 7n,
  startBlock: 100n,
  host: '0x000000000000000000000000000000000000b10c',
  finalized: true,
  hitCount: 12n,
  tokenId: 3n,
  parentSessionId: 0n,
  tipPool: 0n,
};

let finalized = true;
let balance: UseBalanceResult;
const refresh = vi.fn();
const send = vi.fn();
const topUpFn = vi.fn<UseTopUpResult['topUp']>();
let topUpState: Omit<UseTopUpResult, 'topUp'> = { phase: null, error: null, topUpsLeft: null };
/** W13: what the phone's feed holds (the strip shows this player's live notes). */
let feedHits: HitEvent[] = [];
let headHint: { block: bigint; atMs: number } | null = null;

/** W21b: the finalized phone's tip share (ClaimShare). */
let tipShareWei: bigint | null = null;
vi.mock('@/lib/tips/claims', () => ({ useTipShare: () => ({ claimableWei: tipShareWei, state: { kind: 'idle' }, claim: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({
  useBurner: () => ({ address: '0x0000000000000000000000000000000000000001', restored: false }),
  useDrip: () => ({ drip: { txHash: null, track: 2, alreadyFunded: false }, loading: false, error: null, retryInSeconds: null }),
  useHitSender: () => ({ send, pending: 0 }),
  useBalance: () => balance,
  useTopUp: () => ({ ...topUpState, topUp: topUpFn }),
  useEventFeed: () => ({
    session: { ...session, finalized },
    pattern: [],
    hitCount: 12,
    uniquePlayers: 3,
    hitsPerMinute: 0,
    avgLatencyMs: null,
    connected: true,
    lastHit: null,
    error: null,
    hits: feedHits,
    headHint,
  }),
}));

// W16: the phone runs the runtime block clock; here it never ticks, so the strip estimates the head from the feed.
vi.mock('@/lib/runtime', () => ({
  getRuntime: () => ({
    clock: {
      getState: () => ({ currentBlock: 0n, currentStep: 0, measuredBlockMs: 300, msSinceHead: 0, source: 'mock' }),
      onStep: () => () => undefined,
      onHead: () => () => undefined,
      predictBlock: () => 0n,
      start: () => undefined,
      stop: () => undefined,
      setStartBlock: () => undefined,
    },
  }),
}));

const { JoinView } = await import('./JoinView');

// W16: these tests are about a returning player; the first-visit tour has its own tests.
beforeEach(() => {
  window.localStorage.setItem('blockbeat:phone:tour', 'done');
});

function withBalance(mon: string | null, notes: number | null): UseBalanceResult {
  return {
    balanceWei: mon === null ? null : parseEther(mon),
    notesLeft: notes,
    level: notes === null ? null : notes === 0 ? 'out' : notes <= 2 ? 'low' : 'ok',
    error: null,
    refresh,
  };
}

describe('JoinView after finalize', () => {
  beforeEach(() => {
    finalized = true;
    balance = withBalance(null, null);
  });
  afterEach(cleanup);

  it('disables the pads and points at the minted track', () => {
    render(<JoinView sessionId={7n} />);
    const pads = screen.getByTestId('pads').querySelectorAll('button');
    expect(pads).toHaveLength(8);
    for (const pad of pads) expect(pad.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('landing-line').textContent).toMatch(/track minted/i);
    expect(screen.getByRole('link', { name: /open the track/i }).getAttribute('href')).toBe('/track/3');
  });
});

describe('JoinView balance (W12)', () => {
  beforeEach(() => {
    finalized = false;
    refresh.mockReset();
    send.mockReset();
    // W16: these taps are the original immediate sends.
    window.localStorage.setItem('blockbeat:phone:mode', 'now');
  });
  afterEach(cleanup);

  it('shows the balance and notes left in the header pill', () => {
    balance = withBalance('0.2149', 21);
    render(<JoinView sessionId={7n} />);
    expect(screen.getByTestId('funds-pill').textContent).toBe('0.214 MON · ~21 notes');
    expect(screen.queryByTestId('funds-banner')).toBeNull();
  });

  it('warns clearly at two notes or fewer', () => {
    balance = withBalance('0.025', 2);
    render(<JoinView sessionId={7n} />);
    expect(screen.getByTestId('funds-pill').textContent).toBe('Almost out of MON · 2 notes left');
    expect(screen.getByTestId('funds-banner').textContent).toMatch(/almost out of MON/i);
  });

  it('refreshes the balance after a landed hit', async () => {
    balance = withBalance('0.2', 20);
    send.mockResolvedValueOnce({ txHash: `0x${'ab'.repeat(32)}`, blockNumber: 120n, step: 4, on: true, latencyMs: 400 });
    render(<JoinView sessionId={7n} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Pad 1, / }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('says Out of MON instead of a generic error when a hit fails for funds', async () => {
    balance = withBalance('0.016', 1);
    send.mockRejectedValueOnce(new HitError('SEND_FAILED', 'hit send failed: Signer had insufficient balance'));
    render(<JoinView sessionId={7n} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Pad 1, / }));
    });
    expect(screen.getByTestId('landing-line').textContent).toMatch(/out of MON/i);
    expect(screen.getByTestId('funds-pill').textContent).toBe('Out of MON');
    expect(screen.getByTestId('funds-banner').textContent).toMatch(/out of MON/i);
    expect(refresh).toHaveBeenCalled();
  });
});

describe('JoinView top-up (W12)', () => {
  beforeEach(() => {
    finalized = false;
    refresh.mockReset();
    topUpFn.mockReset();
    topUpState = { phase: null, error: null, topUpsLeft: null };
  });
  afterEach(cleanup);

  it('offers Top up in the almost-out state and refreshes the balance after it', async () => {
    balance = withBalance('0.012', 0);
    topUpFn.mockResolvedValueOnce(true);
    render(<JoinView sessionId={7n} />);
    const button = screen.getByRole('button', { name: 'Top up' });
    expect(button.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(topUpFn).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
  });

  it('shows no Top up while the wallet is healthy', () => {
    balance = withBalance('0.2', 20);
    render(<JoinView sessionId={7n} />);
    expect(screen.queryByRole('button', { name: 'Top up' })).toBeNull();
  });

  it('holds Top up while the balance is still above the 0.03 MON line and says why', () => {
    balance = withBalance('0.034', 2);
    render(<JoinView sessionId={7n} />);
    expect(screen.getByRole('button', { name: 'Top up' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('funds-banner').textContent).toMatch(/opens below 0\.03 MON/);
  });

  it('shows the funding countdown in the pill while topping up', () => {
    balance = withBalance('0.012', 0);
    topUpState = { phase: { kind: 'settling', until: Date.now() + 1_800 }, error: null, topUpsLeft: null };
    render(<JoinView sessionId={7n} />);
    expect(screen.getByTestId('funds-pill').textContent).toBe('Topping up · 2 s');
    expect(screen.getByRole('button', { name: /topping up/i }).hasAttribute('disabled')).toBe(true);
  });

  it('explains a refusal and hides the button once no top-ups are left', () => {
    balance = withBalance('0.012', 0);
    topUpState = { phase: null, error: { code: 'TOPUP_LIMIT_REACHED', message: 'raw server text' }, topUpsLeft: 0 };
    render(<JoinView sessionId={7n} />);
    expect(screen.getByTestId('funds-banner').textContent).toMatch(/no top-ups left/i);
    expect(screen.getByTestId('funds-banner').textContent).not.toMatch(/raw server text/);
    expect(screen.queryByRole('button', { name: 'Top up' })).toBeNull();
  });
});

describe('JoinView tip share (W21b)', () => {
  beforeEach(() => {
    finalized = true;
    balance = withBalance('0.2', 20);
    window.localStorage.setItem('blockbeat:phone:tour', 'done');
  });
  afterEach(() => {
    cleanup();
    tipShareWei = null;
  });

  it('offers the player share of the tips once the track is minted', () => {
    tipShareWei = 16_000_000_000_000_000n;
    render(<JoinView sessionId={7n} />);
    expect(screen.getByTestId('claim-share').textContent).toContain('You earned 0.016 MON from tips');
    expect(screen.getByRole('button', { name: 'Claim' })).toBeTruthy();
  });
});

describe('JoinView without tips (W21b)', () => {
  beforeEach(() => {
    finalized = false;
    balance = withBalance('0.2', 20);
    window.localStorage.clear();
    window.localStorage.setItem('blockbeat:phone:tour', 'done');
  });
  afterEach(cleanup);

  it('has no tip button, tip line or tally: tips live on /tip, the balance pill stays', () => {
    render(<JoinView sessionId={7n} />);
    expect(screen.queryByRole('button', { name: /tip/i })).toBeNull();
    expect(screen.queryByTestId('tip-line')).toBeNull();
    expect(screen.queryByTestId('tip-tally')).toBeNull();
    expect(screen.getByTestId('funds-pill')).toBeTruthy();
  });
});

describe('JoinView live strip (W13)', () => {
  const ME = '0x0000000000000000000000000000000000000001' as const;
  const OTHER = '0x0000000000000000000000000000000000000002' as const;
  function liveHit(blockNumber: bigint, step: number, player: HitEvent['player']): HitEvent {
    return { sessionId: 1n, player, blockNumber, step, track: 2, note: 0, on: true, txHash: `0x${blockNumber.toString(16).padStart(64, '0')}`, logIndex: 0 };
  }

  beforeEach(() => {
    finalized = false;
    balance = withBalance('0.3', 27);
  });
  afterEach(() => {
    cleanup();
    feedHits = [];
    headHint = null;
    vi.useRealTimers();
  });

  it("lights the steps where this player's notes still play and nothing else", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    feedHits = [liveHit(1000n, 4, ME), liveHit(1001n, 6, OTHER), liveHit(800n, 9, ME)];
    headHint = { block: 1010n, atMs: 10_000 };
    render(<JoinView sessionId={1n} />);
    const strip = screen.getByTestId('step-strip');
    expect(strip.querySelector('[data-step="4"]')?.getAttribute('data-live')).toBe('true');
    expect(strip.querySelector('[data-step="6"]')?.getAttribute('data-live')).toBeNull();
    expect(strip.querySelector('[data-step="9"]')?.getAttribute('data-live')).toBeNull();
    expect(strip.getAttribute('aria-label')).toMatch(/still playing/);
  });

  it('goes dark once the note has lived 8 bars (128 blocks at 300 ms)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    feedHits = [liveHit(1000n, 4, ME)];
    headHint = { block: 1000n, atMs: 10_000 };
    render(<JoinView sessionId={1n} />);
    const strip = screen.getByTestId('step-strip');
    expect(strip.querySelector('[data-step="4"]')?.getAttribute('data-live')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(128 * 300);
    });
    expect(strip.querySelector('[data-step="4"]')?.getAttribute('data-live')).toBeNull();
    expect(strip.querySelector('[data-landed="true"]')).toBeNull();
  });
});
