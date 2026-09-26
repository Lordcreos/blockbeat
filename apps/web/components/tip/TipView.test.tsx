import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther, type Hash } from 'viem';
import { TipError } from '@/lib/tipSender';
import { tipRequiredWei } from '@/lib/tips/constants';
import type { TipNotePost } from '@/lib/tips/hooks';

const TIPPER = '0x0000000000000000000000000000000000000abc' as const;
const TX = `0x${'ab'.repeat(32)}` as Hash;

let hitCount = 0;
let finalized = false;
let balanceWei: bigint | null = parseEther('0.1');
let funding = { ready: true, loading: false, error: null as string | null, retryInSeconds: null as number | null };
const send = vi.fn<(amountWei: bigint) => Promise<unknown>>();
const refresh = vi.fn();
const postTipNote = vi.fn<(post: TipNotePost) => Promise<unknown>>();

vi.mock('@/lib/tips/hooks', () => ({
  useTipper: () => ({ address: TIPPER, restored: false }),
  useTipperFunding: () => funding,
  useSendTip: () => ({ send, pending: false, readyAt: () => null }),
  postTipNote: (post: TipNotePost) => postTipNote(post),
}));
vi.mock('@/lib/tips/claims', () => ({ isMockRuntime: () => true }));
vi.mock('@/lib/hooks', () => ({
  useEventFeed: () => ({
    hitCount,
    session: { sessionId: 7n, startBlock: 1n, host: TIPPER, finalized, hitCount: BigInt(hitCount), tokenId: 0n, parentSessionId: 0n, tipPool: 0n },
    raisedWei: parseEther('0.05'),
    connected: true,
  }),
  useBalance: () => ({ balanceWei, notesLeft: null, level: null, error: null, refresh }),
}));

const { TipView } = await import('./TipView');

describe('TipView (W21b: the tip page)', () => {
  beforeEach(() => {
    hitCount = 0;
    finalized = false;
    balanceWei = parseEther('0.1');
    funding = { ready: true, loading: false, error: null, retryInSeconds: null };
    send.mockReset();
    refresh.mockReset();
    postTipNote.mockReset();
    postTipNote.mockResolvedValue({ ok: true, note: {} });
  });
  afterEach(cleanup);

  it('waits for the music before the first note: tips cannot open yet', () => {
    render(<TipView sessionId={7n} />);
    expect(screen.getByTestId('tip-waiting').textContent).toMatch(/Waiting for the music/);
    expect(screen.getByTestId('tip-waiting').textContent).toMatch(/tips open with the first note/i);
    expect(screen.queryByRole('button', { name: /send tip/i })).toBeNull();
  });

  it('opens the form with the first note: five fixed amounts, 0.01 picked, name and message limits', () => {
    hitCount = 3;
    render(<TipView sessionId={7n} />);
    const amounts = screen.getAllByRole('radio');
    expect(amounts.map((a) => a.getAttribute('value'))).toEqual(['0.01', '0.02', '0.03', '0.04', '0.05']);
    expect((screen.getByRole('radio', { name: '0.01 MON' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText(/your name/i).getAttribute('maxLength')).toBe('24');
    expect(screen.getByLabelText(/message/i).getAttribute('maxLength')).toBe('140');
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByTestId('tip-raised').textContent).toContain('0.05 MON');
  });

  it('sends the picked amount, confirms it and posts the name and message as a note', async () => {
    hitCount = 1;
    send.mockResolvedValue({ txHash: TX, blockNumber: 1234n, amountWei: parseEther('0.02'), latencyMs: 800 });
    render(<TipView sessionId={7n} />);
    fireEvent.click(screen.getByRole('radio', { name: '0.02 MON' }));
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: '  Ana ' } });
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'more kick' } });
    expect(screen.getByTestId('message-count').textContent).toBe('9 / 140');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send tip' }));
    });
    expect(send).toHaveBeenCalledWith(parseEther('0.02'));
    expect(screen.getByTestId('tip-confirmed').textContent).toMatch(/0\.02 MON landed/);
    expect(postTipNote).toHaveBeenCalledWith({ sessionId: 7n, txHash: TX, name: 'Ana', message: 'more kick', mock: { from: TIPPER, amountWei: parseEther('0.02') } });
    expect(screen.getByTestId('note-status').textContent).toMatch(/on the big screen/i);
    expect(refresh).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send another tip' }));
    expect(screen.getByRole('button', { name: 'Send tip' })).toBeTruthy();
  });

  it('shows the sending state while the tip is out', async () => {
    hitCount = 1;
    send.mockReturnValue(new Promise(() => undefined));
    render(<TipView sessionId={7n} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send tip' }));
    });
    expect(screen.getByRole('button', { name: /sending 0\.01 MON/i }).hasAttribute('disabled')).toBe(true);
  });

  it('explains a refused tip and lets the tipper try again', async () => {
    hitCount = 1;
    send.mockRejectedValue(new TipError('NO_HITS', 'no hits'));
    render(<TipView sessionId={7n} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send tip' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/tips open with the first note/i);
    expect(postTipNote).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send tip' }).hasAttribute('disabled')).toBe(false);
  });

  it('says when the note did not reach the server; the tip itself still landed', async () => {
    hitCount = 1;
    send.mockResolvedValue({ txHash: TX, blockNumber: 5n, amountWei: parseEther('0.01'), latencyMs: 1 });
    postTipNote.mockResolvedValue({ ok: false, code: 'RATE_LIMITED', message: 'slow down' });
    render(<TipView sessionId={7n} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send tip' }));
    });
    expect(screen.getByTestId('tip-confirmed')).toBeTruthy();
    expect(screen.getByTestId('note-status').textContent).toMatch(/could not reach the big screen/i);
  });

  it('greys out the amounts this phone cannot pay for', () => {
    hitCount = 1;
    balanceWei = tipRequiredWei(parseEther('0.02'));
    render(<TipView sessionId={7n} />);
    expect((screen.getByRole('radio', { name: '0.02 MON' }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('radio', { name: '0.03 MON' }) as HTMLInputElement).disabled).toBe(true);
    balanceWei = tipRequiredWei(parseEther('0.01')) - 1n;
    cleanup();
    render(<TipView sessionId={7n} />);
    expect(screen.getByRole('button', { name: 'Send tip' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('tip-funds').textContent).toMatch(/not enough MON/i);
  });

  it('keeps the form closed while the tip wallet is being funded, and says why it failed', () => {
    hitCount = 1;
    funding = { ready: false, loading: true, error: null, retryInSeconds: null };
    render(<TipView sessionId={7n} />);
    expect(screen.getByRole('button', { name: 'Send tip' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('tip-funds').textContent).toMatch(/getting your tip wallet ready/i);
    cleanup();
    funding = { ready: false, loading: false, error: 'TIPPERS_EXHAUSTED: no more tipper wallets', retryInSeconds: null };
    render(<TipView sessionId={7n} />);
    expect(screen.getByTestId('tip-funds').textContent).toMatch(/could not fund/i);
  });
});
