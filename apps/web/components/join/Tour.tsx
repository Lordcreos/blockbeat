'use client';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { placeTourCard, type TargetRect, type TourStep } from '@/lib/join/tour';
import { useReducedMotion } from '@/components/useReducedMotion';

interface TourProps {
  steps: readonly TourStep[];
  open: boolean;
  onClose(): void;
}

/** Padding of the highlight around its target. */
const SPOT_PAD = 6;

/**
 * W16 follow-up: a coach-mark tour of the phone, in the spirit of driver.js but built on the
 * app's own tokens. A dim layer with a cut-out highlights each part of the phone; a card says
 * what it does. The layer blocks taps while the tour runs; Escape or Skip closes it, focus stays
 * in the card and returns to where it was when the tour ends.
 */
export function Tour({ steps, open, onClose }: TourProps) {
  // Mounted only while open, so every opening starts at step 1 with fresh measurements.
  return open && steps.length > 0 ? <TourCard steps={steps} onClose={onClose} /> : null;
}

const nextFrame = (cb: () => void): (() => void) => {
  if (typeof window.requestAnimationFrame === 'function') {
    const id = window.requestAnimationFrame(cb);
    return () => window.cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
};

function TourCard({ steps, onClose }: { steps: readonly TourStep[]; onClose(): void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [cardHeight, setCardHeight] = useState(0);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const reducedMotion = useReducedMotion();
  const titleId = useId();
  const bodyId = useId();
  const step = steps[Math.min(index, steps.length - 1)] ?? steps[0];
  const last = index >= steps.length - 1;

  // Remember who had focus, and give it back when the tour closes.
  useEffect(() => {
    // Safari does not focus a tapped button, so "before" can be <body>: nothing to give back then.
    const active = document.activeElement;
    const before = active instanceof HTMLElement && active !== document.body ? active : null;
    return () => before?.focus();
  }, []);

  // Measure the step's target and the card after layout, and again on resize or rotation.
  useEffect(() => {
    const measure = (): void => {
      const target = step?.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
      const r = target?.getBoundingClientRect();
      setRect(r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null);
      setCardHeight(cardRef.current?.getBoundingClientRect().height ?? 0);
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    const cancel = nextFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancel();
      window.removeEventListener('resize', measure);
    };
  }, [step]);

  // Focus the main action once the card is placed: a browser ignores focus() on a hidden element.
  const placed = viewport !== null;
  useEffect(() => {
    if (placed) nextRef.current?.focus();
  }, [placed, index]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Keep keyboard focus inside the card while the tour runs.
    const buttons = [...(cardRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : at === buttons.length - 1 ? 0 : at + 1;
    event.preventDefault();
    buttons[next]?.focus();
  };

  if (!step) return null;
  const placement = viewport ? placeTourCard(rect, cardHeight, viewport) : null;
  const motion = reducedMotion ? 'none' : 'top 220ms var(--ease-out), left 220ms var(--ease-out), width 220ms var(--ease-out), height 220ms var(--ease-out)';

  return (
    <div className="fixed inset-0 z-50" style={{ touchAction: 'none' }}>
      {/* The tap blocker; with a target the spotlight's shadow does the dimming. */}
      <div aria-hidden="true" className="absolute inset-0" style={{ background: rect ? 'transparent' : 'rgba(5, 5, 7, 0.78)' }} />
      {rect && (
        <div
          aria-hidden="true"
          data-testid="tour-spotlight"
          className="pointer-events-none absolute rounded-[14px]"
          style={{
            top: `${rect.top - SPOT_PAD}px`,
            left: `${rect.left - SPOT_PAD}px`,
            width: `${rect.right - rect.left + SPOT_PAD * 2}px`,
            height: `${rect.bottom - rect.top + SPOT_PAD * 2}px`,
            boxShadow: '0 0 0 9999px rgba(5, 5, 7, 0.78), 0 0 0 2px var(--ink), 0 0 24px 4px rgba(255, 255, 255, 0.25)',
            transition: motion,
          }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
        className="absolute left-3 right-3 flex flex-col gap-3 rounded-[16px] p-4"
        style={{
          top: placement ? `${placement.top}px` : '50%',
          transform: placement ? undefined : 'translateY(-50%)',
          visibility: placement ? 'visible' : 'hidden',
          background: 'var(--surface-1)',
          boxShadow: '0 12px 40px -8px rgba(0, 0, 0, 0.8), inset 0 0 0 1px var(--line-strong)',
          transition: reducedMotion ? 'none' : 'top 220ms var(--ease-out)',
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={titleId} style={{ fontSize: 'var(--text-lg)', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
            {step.title}
          </h2>
          <span className="num shrink-0" style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-muted)' }}>
            {index + 1} of {steps.length}
          </span>
        </div>
        <p id={bodyId} style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', lineHeight: 1.4 }}>
          {step.body}
        </p>
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={onClose} className="min-h-[44px] rounded-full px-3 font-semibold" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
            Skip tour
          </button>
          <div className="flex gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                className="min-h-[44px] rounded-full px-4 font-semibold"
                style={{ fontSize: 'var(--text-sm)', background: 'var(--surface-2)', boxShadow: 'inset 0 0 0 1px var(--line-strong)' }}
              >
                Back
              </button>
            )}
            <button
              ref={nextRef}
              type="button"
              onClick={() => (last ? onClose() : setIndex((i) => i + 1))}
              className="min-h-[44px] rounded-full px-5 font-semibold"
              style={{ fontSize: 'var(--text-sm)', background: 'var(--ink)', color: 'var(--ink-on-track)' }}
            >
              {last ? 'Start playing' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
