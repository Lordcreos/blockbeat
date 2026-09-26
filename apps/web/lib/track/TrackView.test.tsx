import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TrackView } from '@/components/track/TrackView';
import type { TrackView as TrackData } from './read';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 336 176"></svg>';
const svgUri = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;

const track: TrackData = {
  tokenId: 3n,
  sessionId: 9n,
  metadata: { name: 'Blockbeat Track #3', description: 'desc', imageSvg: SVG, imageDataUri: svgUri, attributes: [{ traitType: 'hits', value: 1234 }] },
  host: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  hitCount: 1234n,
  tipPool: 5_000_000_000_000_000n,
  contributors: [
    { address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', hits: 1000n, share: 1000 / 1234 },
    { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', hits: 234n, share: 234 / 1234 },
  ],
  pattern: Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 1n : 0n)),
};

describe('TrackView', () => {
  afterEach(cleanup);

  it('renders the name, SVG as an image, attributes, tip pool and contributors', () => {
    render(<TrackView track={track} explorerUrl={null} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Blockbeat Track #3');
    expect(screen.getByTestId('track-image').getAttribute('src')).toBe(svgUri);
    expect(screen.getByTestId('recorded-note').textContent).toBe('Recorded pattern: every note the room played');
    expect(screen.getByTestId('attr-hits').textContent).toBe('1,234');
    expect(screen.getByTestId('tip-pool').textContent).toBe('0.005 MON');
    const rows = screen.getByTestId('contributors').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('0x90F7…b906');
    expect(rows[0]?.textContent).toContain('81%');
    expect(screen.getByText(/local anvil chain, no explorer/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /session 9 stage/i }).getAttribute('href')).toBe('/stage/9');
  });

  it('W15: can be played, and links to the gallery of every track', () => {
    render(<TrackView track={track} explorerUrl={null} />);
    expect(screen.getByRole('button', { name: /play the track/i })).toBeTruthy();
    expect(screen.getByText(/rebuilt from chain state/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /all tracks/i }).getAttribute('href')).toBe('/tracks');
  });

  it('links to the explorer when given one', () => {
    render(<TrackView track={track} explorerUrl="https://testnet.monadscan.com/nft/0xabc/3" />);
    expect(screen.getByRole('link', { name: /view on monadscan/i }).getAttribute('href')).toBe('https://testnet.monadscan.com/nft/0xabc/3');
  });

  it('says so when nobody played', () => {
    render(<TrackView track={{ ...track, contributors: [] }} explorerUrl={null} />);
    expect(screen.getByText(/nobody played/i)).toBeTruthy();
  });
});
