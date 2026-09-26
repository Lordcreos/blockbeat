/**
 * W16 follow-up: the phone's first-visit tour. Pure: the steps (what each part of the phone
 * does, in the order a thumb meets it) and where the card goes so it never covers its target
 * and never leaves the screen. components/join/Tour.tsx draws it.
 */

/** data-tour anchors on the phone; null = a centred card with no highlight. */
export type TourTarget = 'tabs' | 'pads' | 'mode' | 'steps' | 'result';

export interface TourStep {
  target: TourTarget | null;
  title: string;
  body: string;
}

export function tourSteps({ startTrack }: { startTrack: string }): TourStep[] {
  return [
    {
      target: 'tabs',
      title: 'Pick your instrument',
      body: `You start on ${startTrack}. Switch to any of the eight whenever you like; the colours follow.`,
    },
    {
      target: 'pads',
      title: 'Eight different sounds',
      body: 'Each pad is a different note, chord or drum. Tap one to hear it quietly on your phone.',
    },
    {
      target: 'mode',
      title: 'Aim or Tap now',
      body: 'Aim: you choose the step and your phone times the send. Tap now: your note goes at once and the next block decides.',
    },
    {
      target: 'steps',
      title: 'The loop, driven by Monad',
      body: 'Every block moves the light one step. Pick a sound, then tap a step: up to 4 notes per loop, like kicks on 0, 4, 8, 12.',
    },
    {
      target: 'result',
      title: 'The chain confirms',
      body: 'Here you see where your note really landed, like "aimed step 7 · landed step 7". Sometimes one step late: that is the chain.',
    },
    {
      target: null,
      title: 'Keep playing',
      body: 'Notes fade after about 38 seconds, so keep your part alive. Tap How to play at the bottom to see this again.',
    },
  ];
}

/** Space between the highlighted target and the card, and the card's minimum distance from the screen edge. */
export const TOUR_GAP = 12;
export const TOUR_MARGIN = 12;

export interface TargetRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface CardPlacement {
  side: 'below' | 'above' | 'center';
  top: number;
}

/** Below a target in the top half of the screen, above one in the bottom half, clamped inside the margins. */
export function placeTourCard(target: TargetRect | null, cardHeight: number, viewport: { width: number; height: number }): CardPlacement {
  if (target === null) return { side: 'center', top: (viewport.height - cardHeight) / 2 };
  const clamp = (top: number): number => Math.min(Math.max(top, TOUR_MARGIN), viewport.height - TOUR_MARGIN - cardHeight);
  const middle = (target.top + target.bottom) / 2;
  if (middle < viewport.height / 2) return { side: 'below', top: clamp(target.bottom + TOUR_GAP) };
  return { side: 'above', top: clamp(target.top - TOUR_GAP - cardHeight) };
}
