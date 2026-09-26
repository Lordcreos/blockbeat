import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '@/lib/types';
import { encodePatternProp } from '@/lib/track/pattern';
import { TrackGallery, type GalleryItem } from './TrackGallery';

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

const SVG_URI = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
const item = (tokenId: number, sessionId: number): GalleryItem => ({
  tokenId: String(tokenId),
  sessionId: String(sessionId),
  name: `Blockbeat Track #${tokenId}`,
  imageDataUri: SVG_URI,
  contributors: tokenId + 2,
  hits: String(tokenId * 10),
  tipPoolWei: '5000000000000000',
  pattern: encodePatternProp(Array.from({ length: 16 }, () => 1n)),
});

describe('TrackGallery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('says so when nothing was minted', () => {
    render(<TrackGallery items={[]} createEngine={silentEngine} />);
    expect(screen.getByRole('heading', { name: /no tracks minted yet/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /host a session/i }).getAttribute('href')).toBe('/host');
  });

  it('lists each track in the given order with its cover, session, contributors, hits, tip pool and link', () => {
    render(<TrackGallery items={[item(2, 5), item(1, 2)]} createEngine={silentEngine} />);
    const rows = screen.getAllByTestId('gallery-track');
    expect(rows.map((r) => r.getAttribute('data-token'))).toEqual(['2', '1']);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByRole('heading', { name: 'Track #2' })).toBeTruthy();
    expect(first.getByText(/session 5/i)).toBeTruthy();
    expect(first.getByTestId('gallery-contributors').textContent).toBe('4');
    expect(first.getByTestId('gallery-hits').textContent).toBe('20');
    expect(first.getByTestId('gallery-tips').textContent).toBe('0.005 MON');
    expect(first.getByRole('link', { name: 'Track #2' }).getAttribute('href')).toBe('/track/2');
    expect(first.getByTestId('gallery-image-2').getAttribute('src')).toBe(SVG_URI);
  });

  it('plays inline, one track at a time', async () => {
    render(<TrackGallery items={[item(2, 5), item(1, 2)]} createEngine={silentEngine} />);
    const [a, b] = screen.getAllByTestId('gallery-track') as HTMLElement[];
    await act(async () => {
      fireEvent.click(within(a as HTMLElement).getByRole('button', { name: /play track #2/i }));
    });
    expect(within(a as HTMLElement).getByTestId('cover-playhead')).toBeTruthy();
    expect(within(a as HTMLElement).getByRole('button', { name: /stop track #2/i }).getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.click(within(b as HTMLElement).getByRole('button', { name: /play track #1/i }));
    });
    expect(within(a as HTMLElement).queryByTestId('cover-playhead')).toBeNull();
    expect(within(b as HTMLElement).getByTestId('cover-playhead')).toBeTruthy();
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
  });
});
