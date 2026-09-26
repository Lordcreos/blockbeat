import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEther, type Address, type Hash } from 'viem';
import { TrackTips } from './TrackTips';

const A = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address;
const B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const DJ = '0x2222222222222222222222222222222222222222' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hash;

describe('TrackTips (W21b: the split and the tip list on /track)', () => {
  afterEach(cleanup);

  it('shows raised, the host share, the pool and each player notes, share and MON; the DJ takes no tips', () => {
    render(
      <TrackTips
        hostWei={parseEther('0.004')}
        hostClaimableWei={parseEther('0.004')}
        poolWei={parseEther('0.016')}
        contributors={[
          { address: DJ, hits: 6n },
          { address: A, hits: 3n },
          { address: B, hits: 1n },
        ]}
        agent={DJ}
        lines={[{ txHash: TX, from: A, amountWei: parseEther('0.02'), name: 'Ana', message: '<i>more kick</i>', at: Date.UTC(2026, 8, 26, 16, 5) }]}
      />,
    );
    expect(screen.getByTestId('track-raised').textContent).toBe('0.02 MON');
    expect(screen.getByTestId('track-host-share').textContent).toBe('0.004 MON');
    expect(screen.getByTestId('track-host-claimable').textContent).toBe('0.004 MON not claimed yet');
    expect(screen.getByTestId('tip-pool').textContent).toBe('0.016 MON');
    const rows = screen.getByTestId('contributors').querySelectorAll('tbody tr');
    expect([...rows].map((r) => r.getAttribute('data-player'))).toEqual([A, B, DJ]);
    expect(rows[0]?.textContent).toContain('75%');
    expect(rows[0]?.textContent).toContain('0.012 MON');
    expect(rows[1]?.textContent).toContain('25%');
    expect(rows[1]?.textContent).toContain('0.004 MON');
    expect(rows[2]?.textContent).toContain('6');
    expect(rows[2]?.textContent).toContain('DJ takes no tips');
    const tip = screen.getByTestId('track-tip');
    expect(tip.textContent).toContain('Ana');
    expect(tip.textContent).toContain('<i>more kick</i>');
    expect(tip.querySelector('i')).toBeNull();
    expect(tip.querySelector('time')?.getAttribute('dateTime')).toBe('2026-09-26T16:05:00.000Z');
  });

  it('says the host share was claimed, and handles a contract without the split and no tips', () => {
    const { rerender } = render(<TrackTips hostWei={1n} hostClaimableWei={0n} poolWei={0n} contributors={[]} agent={null} lines={[]} />);
    expect(screen.getByTestId('track-host-claimable').textContent).toBe('claimed');
    expect(screen.getByText(/nobody played/i)).toBeTruthy();
    expect(screen.getByText(/no tips for this track yet/i)).toBeTruthy();
    rerender(<TrackTips hostWei={null} hostClaimableWei={null} poolWei={5n} contributors={[{ address: A, hits: 1n }]} agent={null} lines={[]} />);
    expect(screen.getByTestId('track-host-share').textContent).toBe('—');
    expect(screen.queryByTestId('track-host-claimable')).toBeNull();
  });
});
