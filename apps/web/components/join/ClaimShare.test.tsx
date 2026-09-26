import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TipShareState } from '@/lib/tips/claims';

let claimableWei: bigint | null = null;
let state: TipShareState = { kind: 'idle' };
const claim = vi.fn(async () => undefined);
vi.mock('@/lib/tips/claims', () => ({ useTipShare: () => ({ claimableWei, state, claim }) }));

const { ClaimShare } = await import('./ClaimShare');
const ME = '0x0000000000000000000000000000000000000001' as const;

describe('ClaimShare (W21b: the phone claims its tip share after finalize)', () => {
  beforeEach(() => {
    claimableWei = null;
    state = { kind: 'idle' };
    claim.mockClear();
  });
  afterEach(cleanup);

  it('shows nothing while there is nothing to claim', () => {
    const { container, rerender } = render(<ClaimShare sessionId={7n} address={ME} />);
    expect(container.textContent).toBe('');
    claimableWei = 0n;
    rerender(<ClaimShare sessionId={7n} address={ME} />);
    expect(container.textContent).toBe('');
  });

  it('offers the earned MON and claims it with one tap', async () => {
    claimableWei = 16_000_000_000_000_000n;
    render(<ClaimShare sessionId={7n} address={ME} />);
    expect(screen.getByTestId('claim-share').textContent).toContain('You earned 0.016 MON from tips');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('shows the claiming, failed and claimed states', () => {
    claimableWei = 16_000_000_000_000_000n;
    state = { kind: 'claiming' };
    const { rerender } = render(<ClaimShare sessionId={7n} address={ME} />);
    expect(screen.getByRole('button', { name: 'Claiming…' }).hasAttribute('disabled')).toBe(true);
    state = { kind: 'failed', message: 'reverted' };
    rerender(<ClaimShare sessionId={7n} address={ME} />);
    expect(screen.getByRole('alert').textContent).toContain('reverted');
    state = { kind: 'claimed', amountWei: 16_000_000_000_000_000n, txHash: null };
    rerender(<ClaimShare sessionId={7n} address={ME} />);
    expect(screen.getByTestId('claim-share').textContent).toBe("Claimed 0.016 MON. It is in this phone's wallet.");
  });
});
