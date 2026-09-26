import { TRACK_META } from '@blockbeat/shared';
import { PLAYHEAD_GEOMETRY, litCells } from '@/lib/track/pattern';

interface CoverArtProps {
  /** The onchain SVG as a data URI, or null to draw the pattern in CSS (simulator demo). */
  imageDataUri: string | null;
  pattern: readonly bigint[];
  alt: string;
  /** Step under the playhead, or null when stopped. */
  step: number | null;
  reducedMotion: boolean;
  imageTestId?: string;
  className?: string;
}

const pct = (fraction: number): string => `${(fraction * 100).toFixed(4)}%`;

/**
 * W15: the track cover with the playhead laid over it. The column is positioned in the SVG's
 * own coordinates (PLAYHEAD_GEOMETRY), so it lands on the cells at any size. The SVG stays an
 * <img>, which keeps any script in contract output inert.
 */
export function CoverArt({ imageDataUri, pattern, alt, step, reducedMotion, imageTestId = 'track-image', className }: CoverArtProps) {
  return (
    <div className={`relative w-full overflow-hidden rounded-[10px] ${className ?? ''}`} style={{ aspectRatio: PLAYHEAD_GEOMETRY.aspect, background: '#0b0b12', boxShadow: '0 0 0 1px var(--line)' }}>
      {imageDataUri ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img data-testid={imageTestId} src={imageDataUri} alt={alt} className="absolute inset-0 size-full" style={{ imageRendering: 'pixelated' }} />
      ) : (
        <div data-testid="cover-grid" role="img" aria-label={alt} className="absolute inset-0">
          {litCells(pattern).map(({ step: s, track }) => (
            <span
              key={`${s}-${track}`}
              data-lit=""
              className="absolute rounded-[2px]"
              style={{ left: pct((8 + 20 * s) / 336), top: pct((8 + 20 * track) / 176), width: pct(18 / 336), height: pct(18 / 176), background: TRACK_META[track]?.colour }}
            />
          ))}
        </div>
      )}
      {step !== null && (
        <span
          aria-hidden="true"
          data-testid="cover-playhead"
          data-step={step}
          data-reduced={reducedMotion ? 'true' : 'false'}
          className="cover-playhead absolute"
          style={{ left: pct(PLAYHEAD_GEOMETRY.left(step)), width: pct(PLAYHEAD_GEOMETRY.width), top: pct(PLAYHEAD_GEOMETRY.top), height: pct(PLAYHEAD_GEOMETRY.height) }}
        />
      )}
    </div>
  );
}
