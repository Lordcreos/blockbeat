'use client';
import type { PhoneMode } from './landing-line';

interface ModeBarProps {
  mode: PhoneMode;
  onMode(mode: PhoneMode): void;
  preview: boolean;
  onPreview(on: boolean): void;
  accent: string;
}

const MODES: ReadonlyArray<{ id: PhoneMode; label: string }> = [
  { id: 'now', label: 'Tap now' },
  { id: 'aim', label: 'Aim' },
];

/**
 * W16: Aim (pick a sound, pick a step; the phone times the send) or Tap now (the original: the
 * next block decides the step), and the preview-sound switch.
 */
export function ModeBar({ mode, onMode, preview, onPreview, accent }: ModeBarProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-3">
      <div role="group" aria-label="How your notes land" className="flex rounded-full p-[3px]" style={{ background: 'var(--surface-1)', boxShadow: 'inset 0 0 0 1px var(--line)' }}>
        {MODES.map((m) => {
          const on = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={on}
              onClick={() => onMode(m.id)}
              className="min-h-[44px] rounded-full px-4 font-semibold"
              style={{
                fontSize: 'var(--text-sm)',
                background: on ? 'var(--ink)' : 'transparent',
                color: on ? 'var(--ink-on-track)' : 'var(--ink-muted)',
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={preview}
        onClick={() => onPreview(!preview)}
        className="flex min-h-[44px] items-center gap-2 rounded-full pl-1 pr-2"
        style={{ fontSize: 'var(--text-sm)', color: preview ? 'var(--ink)' : 'var(--ink-muted)' }}
      >
        <span
          aria-hidden="true"
          className="relative inline-block h-[24px] w-[40px] rounded-full transition-[background-color] duration-200"
          style={{ background: preview ? accent : 'var(--surface-3)', boxShadow: 'inset 0 0 0 1px var(--line-strong)' }}
        >
          <span
            className="absolute top-[3px] block h-[18px] w-[18px] rounded-full transition-[left] duration-200"
            style={{ left: preview ? 19 : 3, background: preview ? 'var(--ink-on-track)' : 'var(--ink-muted)' }}
          />
        </span>
        Preview sound
      </button>
    </div>
  );
}
