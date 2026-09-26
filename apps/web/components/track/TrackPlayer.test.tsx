import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_MS } from '@blockbeat/shared';
import type { AudioEngine } from '@/lib/types';
import { encodePatternProp } from '@/lib/track/pattern';
import { TrackPlayer } from './TrackPlayer';

function silentEngine(): AudioEngine {
  let started = false;
  return {
    async start() {
      started = true;
    },
    isStarted: () => started,
    setPattern() {},
    attachClock: () => () => undefined,
    playImmediate() {},
    setMasterVolumeDb() {},
    dispose() {},
  };
}

const PATTERN = encodePatternProp(Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 1n : 0n)));
const SVG_URI = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

describe('TrackPlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotion(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows the cover with no playhead until Play is pressed', () => {
    render(<TrackPlayer id="1" name="Blockbeat Track #1" imageDataUri={SVG_URI} pattern={PATTERN} createEngine={silentEngine} />);
    expect(screen.getByTestId('track-image').getAttribute('src')).toBe(SVG_URI);
    expect(screen.queryByTestId('cover-playhead')).toBeNull();
    const play = screen.getByRole('button', { name: /play the track/i });
    expect(play.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/rebuilt from chain state/i)).toBeTruthy();
    expect(screen.getByLabelText(/volume/i)).toBeTruthy();
  });

  it('Play sweeps the playhead across the cover; Stop removes it', async () => {
    render(<TrackPlayer id="1" name="Blockbeat Track #1" imageDataUri={SVG_URI} pattern={PATTERN} createEngine={silentEngine} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /play the track/i }));
    });
    const stop = screen.getByRole('button', { name: /stop/i });
    expect(stop.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('cover-playhead').getAttribute('data-step')).toBe('0');
    await act(async () => {
      vi.advanceTimersByTime(BLOCK_MS * 2);
    });
    expect(screen.getByTestId('cover-playhead').getAttribute('data-step')).toBe('2');
    await act(async () => {
      fireEvent.click(stop);
    });
    expect(screen.queryByTestId('cover-playhead')).toBeNull();
    expect(screen.getByRole('button', { name: /play the track/i })).toBeTruthy();
  });

  it('keeps the button focusable while audio starts (aria-disabled, never disabled)', async () => {
    render(<TrackPlayer id="1" name="t" imageDataUri={SVG_URI} pattern={PATTERN} createEngine={silentEngine} />);
    const play = screen.getByTestId('track-play');
    play.focus();
    await act(async () => {
      fireEvent.click(play);
    });
    expect(play.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(play);
  });

  it('under reduced motion the playhead jumps without a transition', async () => {
    setReducedMotion(true);
    render(<TrackPlayer id="1" name="t" imageDataUri={SVG_URI} pattern={PATTERN} createEngine={silentEngine} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /play the track/i }));
    });
    expect(screen.getByTestId('cover-playhead').getAttribute('data-reduced')).toBe('true');
  });

  it('draws the pattern itself when there is no onchain image (simulator demo)', () => {
    render(<TrackPlayer id="demo" name="Demo loop" imageDataUri={null} pattern={PATTERN} createEngine={silentEngine} />);
    expect(screen.queryByTestId('track-image')).toBeNull();
    expect(screen.getByTestId('cover-grid').querySelectorAll('[data-lit]')).toHaveLength(4);
  });
});
