import { TRACK_META } from '@blockbeat/shared';

/** Who played what: human hits fill the cell, agent hits are hollow with a white core. */
export function Legend() {
  return (
    <div data-testid="legend" className="flex flex-col gap-2" style={{ fontSize: 'var(--text-md)' }}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-6 rounded-[6px]"
            style={{ background: 'var(--track-bass)', boxShadow: '0 0 12px var(--track-bass)' }}
          />
          <span>Human hit</span>
        </span>
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="relative inline-block size-6 rounded-[6px]"
            style={{ background: 'color-mix(in srgb, var(--track-bass) 22%, var(--stage))', outline: '2px solid var(--track-bass)', outlineOffset: '-2px' }}
          >
            <span
              className="absolute left-1/2 top-1/2 size-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ background: 'var(--agent-core)', boxShadow: '0 0 6px var(--agent-ring)' }}
            />
          </span>
          <span>Resident DJ agent</span>
        </span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Tracks">
        {TRACK_META.map((t) => (
          <li key={t.id} className="flex items-center gap-2">
            <span aria-hidden="true" className="inline-block size-3 rounded-full" style={{ background: t.colour }} />
            <span style={{ color: 'var(--ink-muted)' }}>{t.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
