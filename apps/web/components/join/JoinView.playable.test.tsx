/**
 * W16: the playable phone. Instrument tabs, labelled pads, aimed steps with the block-clock
 * playhead, a queue of up to 4 aimed notes, Tap now, and the preview voice.
 */
import { PREF_PREFIX } from '@/lib/join/usePhone';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import { stepForBlock, type HitEvent, type SessionState } from '@blockbeat/shared';
import type { UseBalanceResult } from '@/lib/hooks';
import type { BlockClockState, HitReceipt } from '@/lib/types';

const START = 100n;
const ME = '0x0000000000000000000000000000000000000001' as const;
const OTHER = '0x0000000000000000000000000000000000000002' as const;

const session: SessionState = {
  sessionId: 7n,
  startBlock: START,
  host: '0x000000000000000000000000000000000000b10c',
  finalized: false,
  hitCount: 0n,
  tokenId: 0n,
  parentSessionId: 0n,
  tipPool: 0n,
};

let balance: UseBalanceResult;
const send = vi.fn<(track: number, note: number) => Promise<HitReceipt>>();
let feedHits: HitEvent[] = [];

/** W21b: the finalized phone's tip share (ClaimShare). */
const tipShareWei: bigint | null = null;
vi.mock('@/lib/tips/claims', () => ({ useTipShare: () => ({ claimableWei: tipShareWei, state: { kind: 'idle' }, claim: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({
  useBurner: () => ({ address: ME, restored: false }),
  useDrip: () => ({ drip: { txHash: null, track: 2, alreadyFunded: false }, loading: false, error: null, retryInSeconds: null }),
  useHitSender: () => ({ send, pending: 0 }),
  useBalance: () => balance,
  useTopUp: () => ({ phase: null, error: null, topUpsLeft: null, topUp: vi.fn() }),
  useEventFeed: () => ({
    session,
    pattern: Array.from({ length: 16 }, () => 0n),
    hitCount: 0,
    uniquePlayers: 1,
    hitsPerMinute: 0,
    avgLatencyMs: null,
    connected: true,
    lastHit: null,
    error: null,
    hits: feedHits,
    headHint: null,
  }),
}));

// The runtime block clock, driven by hand.
let block = 0n;
const stepCbs = new Set<(step: number, at: number) => void>();
const clock = {
  getState: (): BlockClockState => ({ currentBlock: block, currentStep: 0, measuredBlockMs: 300, msSinceHead: 0, source: 'mock' }),
  onStep(cb: (step: number, at: number) => void) {
    stepCbs.add(cb);
    return () => stepCbs.delete(cb);
  },
  onHead: () => () => undefined,
  predictBlock: () => block,
  start: vi.fn(),
  stop: vi.fn(),
  setStartBlock: vi.fn(),
};
vi.mock('@/lib/runtime', () => ({ getRuntime: () => ({ clock }) }));

const play = vi.fn(() => true);
vi.mock('@/lib/audio/preview', () => ({ createPreviewVoice: () => ({ play, dispose: vi.fn() }) }));

const { JoinView } = await import('./JoinView');

function tick(to: bigint): void {
  act(() => {
    block = to;
    for (const cb of [...stepCbs]) cb(0, 0);
  });
}

/** The phone times a send with a timer armed up to one block (300 ms) ahead; wait just over that. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
}

function receipt(blockNumber: bigint): HitReceipt {
  return { txHash: `0x${blockNumber.toString(16).padStart(64, '0')}`, blockNumber, step: stepForBlock(START, blockNumber), on: true, latencyMs: 350 };
}

const tabs = () => screen.getByRole('tablist', { name: /instrument/i });
const pad = (n: number) => screen.getByRole('button', { name: new RegExp(`^Pad ${n}, `) });
const stepCell = (n: number) => screen.getByRole('button', { name: new RegExp(`^Step ${n}\\b`) });
const strip = () => screen.getByTestId('step-strip');

beforeEach(() => {
  balance = { balanceWei: parseEther('0.3'), notesLeft: 27, level: 'ok', error: null, refresh: vi.fn() };
  send.mockReset();
  play.mockClear();
  window.localStorage.clear();
  // The first-visit tour has its own tests below; here the player has seen it.
  window.localStorage.setItem('blockbeat:phone:tour', 'done');
  feedHits = [];
  block = 0n;
});
afterEach(() => {
  cleanup();
  stepCbs.clear();
});

describe('instrument choice', () => {
  it('shows the 8 tracks as tabs, starting on the one the drip assigned', () => {
    render(<JoinView sessionId={7n} />);
    const all = within(tabs()).getAllByRole('tab');
    expect(all.map((t) => t.textContent)).toEqual(['Kick', 'Snare', 'Hat', 'Clap', 'Bass', 'Lead', 'Pad', 'FX']);
    expect(within(tabs()).getByRole('tab', { selected: true }).textContent).toBe('Hat');
    expect(screen.getByTestId('track-name').textContent).toBe('Hat');
  });

  it('switching instrument changes the header, the colour and the pad names', () => {
    render(<JoinView sessionId={7n} />);
    fireEvent.click(within(tabs()).getByRole('tab', { name: 'Bass' }));
    expect(screen.getByTestId('track-name').textContent).toBe('Bass');
    expect(screen.getByTestId('track-name').getAttribute('style')).toMatch(/--track-bass/);
    expect(screen.getByTestId('pads').getAttribute('aria-labelledby')).toBe('track-tab-4');
    expect(within(screen.getByTestId('pads')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Pad 1, A1',
      'Pad 2, C2',
      'Pad 3, D2',
      'Pad 4, E2',
      'Pad 5, G2',
      'Pad 6, A2',
      'Pad 7, C3',
      'Pad 8, A2 open',
    ]);
  });

  it('arrow keys move between tabs', () => {
    render(<JoinView sessionId={7n} />);
    const hat = within(tabs()).getByRole('tab', { name: 'Hat' });
    fireEvent.keyDown(hat, { key: 'ArrowRight' });
    expect(within(tabs()).getByRole('tab', { selected: true }).textContent).toBe('Clap');
    fireEvent.keyDown(within(tabs()).getByRole('tab', { name: 'Clap' }), { key: 'ArrowLeft' });
    expect(within(tabs()).getByRole('tab', { selected: true }).textContent).toBe('Hat');
  });

  it('a Tap now note goes out on the selected instrument, not the assigned one', async () => {
    window.localStorage.setItem('blockbeat:phone:mode', 'now');
    send.mockResolvedValueOnce(receipt(105n));
    render(<JoinView sessionId={7n} />);
    fireEvent.click(within(tabs()).getByRole('tab', { name: 'Lead' }));
    await act(async () => {
      fireEvent.click(pad(6)); // A4
    });
    expect(send).toHaveBeenCalledWith(5, 12);
  });
});

describe('aimed steps', () => {
  // Tap now is the default mode; these specs exercise Aim, so the player has picked it.
  beforeEach(() => {
    window.localStorage.setItem(`${PREF_PREFIX}mode`, 'aim');
  });
  afterEach(() => {
    window.localStorage.removeItem(`${PREF_PREFIX}mode`);
  });

  it('draws the playhead from the block clock', () => {
    render(<JoinView sessionId={7n} />);
    tick(107n);
    expect(strip().querySelector('[data-playhead="true"]')?.getAttribute('data-step')).toBe('7');
    tick(108n);
    expect(strip().querySelector('[data-playhead="true"]')?.getAttribute('data-step')).toBe('8');
  });

  it('pick a pad, tap a step: the note waits, is sent lead blocks before, and says where it landed', async () => {
    let land: (r: HitReceipt) => void = () => undefined;
    send.mockImplementationOnce(() => new Promise((r) => (land = r)));
    render(<JoinView sessionId={7n} />);
    tick(100n);
    fireEvent.click(pad(1)); // Hat 'Closed'
    expect(pad(1).getAttribute('aria-pressed')).toBe('true');
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(stepCell(7));
    expect(screen.getByTestId('aim-queue').textContent).toMatch(/step 7.*Closed/i);
    expect(stepCell(7).getAttribute('data-queued')).toBe('true');
    tick(105n);
    expect(send).not.toHaveBeenCalled();
    tick(106n); // target 107 − lead 1
    await flush();
    expect(send).toHaveBeenCalledWith(2, 3);
    // The phone's feed sees the Hit log the sender resolved on.
    feedHits = [{ sessionId: 7n, player: ME, blockNumber: 107n, step: 7, track: 2, note: 3, on: true, txHash: receipt(107n).txHash, logIndex: 0 }];
    await act(async () => {
      land(receipt(107n));
    });
    expect(screen.getByTestId('landing-line').textContent).toMatch(/aimed step 7 · landed step 7/);
    expect(screen.queryByTestId('aim-queue')?.textContent ?? '').not.toMatch(/step 7/i);
    expect(strip().querySelector('[data-landed="true"]')?.getAttribute('data-step')).toBe('7');
  });

  it('says so honestly when a note lands late', async () => {
    send.mockResolvedValueOnce(receipt(108n));
    render(<JoinView sessionId={7n} />);
    tick(100n);
    fireEvent.click(pad(2));
    fireEvent.click(stepCell(7));
    tick(106n);
    await flush();
    expect(screen.getByTestId('landing-line').textContent).toMatch(/aimed step 7 · landed step 8 \(one late\)/);
  });

  it('tap steps first to arm them, then a pad queues it on all of them (4 kicks on 0, 4, 8, 12)', () => {
    render(<JoinView sessionId={7n} />);
    fireEvent.click(within(tabs()).getByRole('tab', { name: 'Kick' }));
    tick(101n);
    for (const s of [0, 4, 8, 12]) fireEvent.click(stepCell(s));
    expect(stepCell(4).getAttribute('data-armed')).toBe('true');
    fireEvent.click(pad(1)); // Deep
    const queue = screen.getByTestId('aim-queue');
    expect(within(queue).getAllByRole('listitem')).toHaveLength(4);
    for (const s of [0, 4, 8, 12]) expect(stepCell(s).getAttribute('data-queued')).toBe('true');
    expect(stepCell(4).getAttribute('data-armed')).toBeNull();
  });

  it('the queue drains as notes land, in send order', async () => {
    const lands: Array<(r: HitReceipt) => void> = [];
    send.mockImplementation(() => new Promise((r) => lands.push(r)));
    render(<JoinView sessionId={7n} />);
    tick(101n);
    fireEvent.click(pad(1));
    for (const s of [4, 8]) fireEvent.click(stepCell(s));
    expect(within(screen.getByTestId('aim-queue')).getAllByRole('listitem')).toHaveLength(2);
    tick(103n);
    await flush();
    await act(async () => lands[0]!(receipt(104n)));
    expect(within(screen.getByTestId('aim-queue')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByTestId('landing-line').textContent).toMatch(/aimed step 4 · landed step 4/);
  });

  it('a fifth aimed note is refused with a reason; tapping a queued step with the same pad cancels it', () => {
    render(<JoinView sessionId={7n} />);
    tick(101n);
    fireEvent.click(pad(1));
    for (const s of [3, 6, 9, 12]) fireEvent.click(stepCell(s));
    fireEvent.click(stepCell(14));
    expect(screen.getByTestId('landing-line').textContent).toMatch(/4 notes aimed/i);
    fireEvent.click(stepCell(12));
    expect(stepCell(12).getAttribute('data-queued')).toBeNull();
  });

  it('never aims more notes than the burner can pay for', () => {
    balance = { ...balance, notesLeft: 1, level: 'low' };
    render(<JoinView sessionId={7n} />);
    tick(101n);
    fireEvent.click(pad(1));
    fireEvent.click(stepCell(8));
    fireEvent.click(stepCell(12));
    expect(screen.getByTestId('landing-line').textContent).toMatch(/not enough MON/i);
    expect(within(screen.getByTestId('aim-queue')).getAllByRole('listitem')).toHaveLength(1);
  });

  it('asks to wait before the block clock has a head', () => {
    render(<JoinView sessionId={7n} />);
    fireEvent.click(pad(1));
    fireEvent.click(stepCell(8));
    expect(screen.getByTestId('landing-line').textContent).toMatch(/block clock/i);
  });

  it('shows live notes of the selected instrument on their steps, own notes marked', () => {
    feedHits = [
      { sessionId: 7n, player: ME, blockNumber: 104n, step: 4, track: 2, note: 3, on: true, txHash: `0x${'01'.padStart(64, '0')}`, logIndex: 0 },
      { sessionId: 7n, player: OTHER, blockNumber: 106n, step: 6, track: 2, note: 7, on: true, txHash: `0x${'02'.padStart(64, '0')}`, logIndex: 0 },
      { sessionId: 7n, player: OTHER, blockNumber: 109n, step: 9, track: 0, note: 0, on: true, txHash: `0x${'03'.padStart(64, '0')}`, logIndex: 0 },
    ];
    render(<JoinView sessionId={7n} />);
    tick(110n);
    expect(stepCell(4).getAttribute('data-live')).toBe('true');
    expect(stepCell(4).getAttribute('aria-label')).toMatch(/your Closed/);
    expect(stepCell(6).getAttribute('data-live')).toBeNull();
    expect(stepCell(6).getAttribute('aria-label')).toMatch(/1 other note/);
    expect(stepCell(9).getAttribute('aria-label')).not.toMatch(/note/); // another instrument
  });
});

describe('Tap now and preview', () => {
  it('Tap now sends at once, as before', async () => {
    send.mockResolvedValueOnce(receipt(103n));
    render(<JoinView sessionId={7n} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tap now' }));
    await act(async () => {
      fireEvent.click(pad(3));
    });
    expect(send).toHaveBeenCalledWith(2, 0);
    expect(screen.getByTestId('landing-line').textContent).toMatch(/landed · block 103 · step 3/);
  });

  it('previews the pad on tap by default, and not when the preview is off', () => {
    render(<JoinView sessionId={7n} />);
    fireEvent.click(pad(2));
    expect(play).toHaveBeenCalledWith(2, 7);
    const toggle = screen.getByRole('switch', { name: /preview sound/i });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    play.mockClear();
    fireEvent.click(pad(4));
    expect(play).not.toHaveBeenCalled();
  });

  it('a failing preview never blocks a Tap now send', async () => {
    play.mockReturnValueOnce(false);
    send.mockResolvedValueOnce(receipt(103n));
    window.localStorage.setItem('blockbeat:phone:mode', 'now');
    render(<JoinView sessionId={7n} />);
    await act(async () => {
      fireEvent.click(pad(1));
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a tap replays the flash on an overlay: the pad node, and so keyboard focus, survive (review)', () => {
    render(<JoinView sessionId={7n} />);
    const p = pad(2);
    p.focus();
    fireEvent.click(p);
    const firstFlash = p.querySelector('[data-flash="true"]');
    expect(firstFlash).not.toBeNull();
    fireEvent.click(pad(2));
    expect(pad(2)).toBe(p);
    expect(document.activeElement).toBe(p);
    expect(p.querySelector('[data-flash="true"]')).not.toBe(firstFlash);
  });

  it('every tap target is at least 44 px (tabs, pads, steps, toggles)', () => {
    render(<JoinView sessionId={7n} />);
    const targets = [...within(tabs()).getAllByRole('tab'), ...Array.from({ length: 16 }, (_, i) => stepCell(i)), screen.getByRole('switch', { name: /preview sound/i }), screen.getByRole('button', { name: 'Tap now' })];
    for (const t of targets) expect(t.className).toMatch(/min-h-\[44px\]/);
  });
});

describe('first-visit tour', () => {
  const frame = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

  it('opens by itself on the first visit once the phone can play, naming the starting instrument', async () => {
    window.localStorage.removeItem('blockbeat:phone:tour');
    render(<JoinView sessionId={7n} />);
    await frame();
    const dialog = screen.getByRole('dialog', { name: 'Pick your instrument' });
    expect(dialog.textContent).toMatch(/You start on Hat/);
  });

  it('closing it (Skip) is remembered: the next visit goes straight to playing', async () => {
    window.localStorage.removeItem('blockbeat:phone:tour');
    const first = render(<JoinView sessionId={7n} />);
    await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.localStorage.getItem('blockbeat:phone:tour')).toBe('done');
    first.unmount();
    render(<JoinView sessionId={7n} />);
    await frame();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the How to play button replays it from the first step', async () => {
    render(<JoinView sessionId={7n} />);
    await frame();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'How to play' }));
    await frame();
    expect(screen.getByRole('dialog', { name: 'Pick your instrument' })).toBeTruthy();
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole('button', { name: /^(Next|Start playing)$/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the replay button is a visible, labelled button in the footer (not a bare icon)', () => {
    render(<JoinView sessionId={7n} />);
    const help = screen.getByRole('button', { name: 'How to play' });
    expect(help.textContent).toMatch(/How to play/);
    expect(help.closest('footer')).not.toBeNull();
    expect(help.className).toMatch(/min-h-\[44px\]/);
  });

  it('every part the tour points at is on the page', () => {
    render(<JoinView sessionId={7n} />);
    for (const target of ['tabs', 'pads', 'mode', 'steps', 'result']) expect(document.querySelector(`[data-tour="${target}"]`), target).not.toBeNull();
  });
});
