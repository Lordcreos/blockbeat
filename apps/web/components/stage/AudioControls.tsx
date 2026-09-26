'use client';

interface AudioControlsProps {
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  /** 0..1 */
  volume: number;
  onVolumeChange: (volume: number) => void;
}

/** Mute toggle and master volume, next to the host controls. */
export function AudioControls({ muted, onMutedChange, volume, onVolumeChange }: AudioControlsProps) {
  return (
    <div className="flex items-center gap-3" aria-label="Audio controls">
      <button
        type="button"
        aria-pressed={muted}
        onClick={() => onMutedChange(!muted)}
        className="rounded-[var(--radius-control)] px-4 py-2 font-medium"
        style={{
          fontSize: 'var(--text-sm)',
          background: muted ? 'var(--danger)' : 'var(--surface-2)',
          color: muted ? 'var(--ink-on-track)' : 'var(--ink)',
          border: '1px solid var(--line-strong)',
        }}
      >
        {muted ? 'Unmute' : 'Mute'}
      </button>
      <label className="flex items-center gap-2" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          aria-label="Master volume"
          aria-valuetext={`${Math.round(volume * 100)} percent`}
          onChange={(e) => onVolumeChange(Number(e.currentTarget.value))}
          className="w-28 accent-white"
        />
      </label>
    </div>
  );
}
