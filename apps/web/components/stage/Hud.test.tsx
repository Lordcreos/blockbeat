import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Hud } from './Hud';

const base = { currentBlock: 1_234n, hitCount: 12, hitsPerMinute: 30, avgLatencyMs: 420, uniquePlayers: 4, measuredBlockMs: 300 };

describe('Hud tips (W12)', () => {
  afterEach(cleanup);

  it('shows the tip pool in MON and the tip count', () => {
    render(<Hud {...base} tipPoolWei={15_000_000_000_000_000n} tipCount={3} tipFlash={0} />);
    expect(screen.getByTestId('hud-tips').textContent).toBe('0.015 MON · 3');
  });

  it('flashes the tips stat when a tip lands and replays on the next one', () => {
    const { rerender } = render(<Hud {...base} tipPoolWei={0n} tipCount={0} tipFlash={0} />);
    expect(screen.getByTestId('hud-tips-wrap').className).not.toMatch(/tip-flash/);
    rerender(<Hud {...base} tipPoolWei={5_000_000_000_000_000n} tipCount={1} tipFlash={1} />);
    const first = screen.getByTestId('hud-tips-wrap');
    expect(first.className).toMatch(/tip-flash/);
    rerender(<Hud {...base} tipPoolWei={10_000_000_000_000_000n} tipCount={2} tipFlash={2} />);
    expect(screen.getByTestId('hud-tips-wrap')).not.toBe(first);
  });
});

describe('Hud live notes (W13)', () => {
  afterEach(cleanup);

  it('shows Live notes next to Hits when decay is on', () => {
    render(<Hud {...base} liveNotes={7} tipPoolWei={0n} tipCount={0} tipFlash={0} />);
    expect(screen.getByTestId('hud-live-notes').textContent).toBe('7');
    expect(screen.getByText('Live notes')).toBeTruthy();
  });

  it('hides it with decay off', () => {
    render(<Hud {...base} liveNotes={null} tipPoolWei={0n} tipCount={0} tipFlash={0} />);
    expect(screen.queryByTestId('hud-live-notes')).toBeNull();
  });
});
