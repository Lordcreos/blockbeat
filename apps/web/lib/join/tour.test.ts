import { describe, expect, it } from 'vitest';
import { TOUR_GAP, TOUR_MARGIN, placeTourCard, tourSteps } from './tour';

const viewport = { width: 390, height: 844 };

describe('tourSteps', () => {
  it('walks the phone top to bottom: instrument, sounds, mode, steps, result, keep playing', () => {
    const steps = tourSteps({ startTrack: 'Hat' });
    expect(steps.map((s) => s.target)).toEqual(['tabs', 'pads', 'mode', 'steps', 'result', null]);
    for (const s of steps) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
      expect(s.body.length).toBeLessThanOrEqual(220); // fits a phone card
    }
  });

  it('the last step says where to see the tour again', () => {
    expect(tourSteps({ startTrack: 'Hat' }).at(-1)?.body).toMatch(/How to play/);
  });

  it('names the instrument the drip gave the player', () => {
    expect(tourSteps({ startTrack: 'Hat' })[0]?.body).toMatch(/You start on Hat/);
  });

  it('explains both modes and what the result line means', () => {
    const text = tourSteps({ startTrack: 'Kick' }).map((s) => `${s.title} ${s.body}`).join(' ');
    expect(text).toMatch(/Aim/);
    expect(text).toMatch(/Tap now/);
    expect(text).toMatch(/aimed step 7 · landed step 7/);
    expect(text).toMatch(/up to 4/i);
  });
});

describe('placeTourCard', () => {
  it('puts the card below a target in the top half', () => {
    const p = placeTourCard({ top: 100, bottom: 150, left: 12, right: 378 }, 180, viewport);
    expect(p).toEqual({ side: 'below', top: 150 + TOUR_GAP });
  });

  it('puts the card above a target in the bottom half', () => {
    const p = placeTourCard({ top: 700, bottom: 780, left: 12, right: 378 }, 180, viewport);
    expect(p).toEqual({ side: 'above', top: 700 - TOUR_GAP - 180 });
  });

  it('never leaves the screen: a tall target gets the card clamped inside the margins', () => {
    const p = placeTourCard({ top: 300, bottom: 800, left: 12, right: 378 }, 200, viewport);
    expect(p.top).toBeGreaterThanOrEqual(TOUR_MARGIN);
    expect(p.top + 200).toBeLessThanOrEqual(viewport.height - TOUR_MARGIN);
  });

  it('centres the card when there is no target (the last step)', () => {
    expect(placeTourCard(null, 200, viewport)).toEqual({ side: 'center', top: (844 - 200) / 2 });
  });
});
