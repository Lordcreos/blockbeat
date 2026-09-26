import { formatInt, formatLatency, measuredBpm } from '@/components/format';
import { formatMon } from '@/lib/funding';

interface HudProps {
  currentBlock: bigint;
  hitCount: number;
  /** W13: notes the room hears right now (the live, decaying layer); null hides the stat (decay off). */
  liveNotes?: number | null;
  hitsPerMinute: number;
  avgLatencyMs: number | null;
  uniquePlayers: number;
  measuredBlockMs: number;
  /**
   * W12: the session's tip pool and how many tips it holds. W21b: optional; the stage shows
   * tips in its own panel (Raised by this song) and leaves the stat out.
   */
  tipPoolWei?: bigint;
  tipCount?: number;
  /** W12: bumped once per tip that lands; replays the flash. 0 = no tip seen yet. */
  tipFlash?: number;
}

interface StatProps {
  id: string;
  label: string;
  value: string;
  /** Fixed width in ch so the number never moves its neighbours. */
  width: number;
  size: 'sm' | 'md' | 'lg' | 'xl';
  /** Columns of the 6-column HUD grid (W13: three stats share the Hits row). */
  cols: 2 | 3 | 6;
}

const COLS = { 2: 'col-span-2', 3: 'col-span-3', 6: 'col-span-6' } as const;

const SIZES = { sm: 'var(--text-lg)', md: 'var(--text-hud)', lg: 'var(--text-hud-lg)', xl: 'var(--text-hud-xl)' } as const;

function Stat({ id, label, value, width, size, cols }: StatProps) {
  return (
    <div className={`${COLS[cols]} flex min-w-0 flex-col gap-1`}>
      <dt style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)', fontWeight: 500 }}>{label}</dt>
      <dd
        data-testid={`hud-${id}`}
        className="num overflow-hidden whitespace-pre font-semibold leading-none"
        style={{
          fontSize: SIZES[size],
          width: `${width}ch`,
          maxWidth: '100%',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '-0.02em',
        }}
      >
        {value}
      </dd>
    </div>
  );
}

/** Up to eight stats, tabular figures, fixed widths: nothing shifts when a number grows. */
export function Hud({ currentBlock, hitCount, liveNotes = null, hitsPerMinute, avgLatencyMs, uniquePlayers, measuredBlockMs, tipPoolWei, tipCount = 0, tipFlash = 0 }: HudProps) {
  const tips = tipPoolWei !== undefined;
  return (
    <dl data-testid="hud" className="grid grid-cols-6 gap-x-6 gap-y-3" aria-label="Live statistics">
      <Stat id="block" label="Block" value={formatInt(currentBlock)} width={12} size="xl" cols={6} />
      <Stat id="bpm" label="BPM" value={String(measuredBpm(measuredBlockMs))} width={4} size="lg" cols={3} />
      <Stat id="players" label="Players" value={formatInt(uniquePlayers)} width={4} size="lg" cols={3} />
      {/* W13: Live notes next to Hits (how many of them the room still hears; notes fade after 8 bars).
          Three to a row so the rail still fits 1080 px with the DJ panel. */}
      <Stat id="hits" label="Hits" value={formatInt(hitCount)} width={7} size="md" cols={liveNotes === null ? 3 : 2} />
      {liveNotes !== null && <Stat id="live-notes" label="Live notes" value={formatInt(liveNotes)} width={5} size="md" cols={2} />}
      <Stat id="hpm" label="Hits / min" value={formatInt(Math.round(hitsPerMinute))} width={5} size="md" cols={liveNotes === null ? 3 : 2} />
      <Stat id="latency" label="Latency" value={formatLatency(avgLatencyMs)} width={8} size="md" cols={tips ? 3 : 6} />
      {/* W12: next to Latency (the rail must fit 1080 px with the DJ panel); smaller figures so "0.025 MON · 5" fits. */}
      {tips && (
        <div key={`tips-${tipFlash}`} data-testid="hud-tips-wrap" className={tipFlash > 0 ? 'tip-flash col-span-3 rounded-[10px]' : 'col-span-3 rounded-[10px]'}>
          <Stat id="tips" label="Tips" value={`${formatMon(tipPoolWei)} MON · ${formatInt(tipCount)}`} width={14} size="sm" cols={6} />
        </div>
      )}
    </dl>
  );
}
