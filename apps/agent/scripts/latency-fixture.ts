/**
 * W14 / W14b: shared fixture for the latency scripts: a realistic live grid (7 decaying room
 * notes, under the 12-note floor, so every call asks the model) and nearest-rank percentiles.
 */
import { emptyPattern, toggle, type LiveHit, type TrackId } from '@blockbeat/shared';
import { buildLiveGrid, type Grid } from '../src/lib/pattern';

const AGENT = '0x2222222222222222222222222222222222222222' as const;
const HUMAN = '0x1111111111111111111111111111111111111111' as const;
const NOW = 100_000n;

/** [step, track, note, blocks ago, who]: a room that played a kick, a clap, hats and a lead, some of it fading. */
const ROOM: Array<[number, TrackId, number, number, 'human' | 'agent']> = [
  [0, 0, 0, 20, 'human'],
  [8, 0, 0, 90, 'human'],
  [4, 3, 0, 40, 'human'],
  [2, 2, 0, 110, 'human'],
  [10, 2, 1, 15, 'human'],
  [3, 5, 4, 60, 'human'],
  [0, 4, 0, 100, 'agent'],
];

export function realisticGrid(): Grid {
  const recorded = emptyPattern();
  const owners = new Map<string, 'human' | 'agent'>();
  const hits: LiveHit[] = ROOM.map(([step, track, note, ago, who], i) => {
    recorded[step] = toggle(recorded[step] ?? 0n, track, note);
    owners.set(`${step}:${track}:${note}`, who);
    return { step, track, note, blockNumber: NOW - BigInt(ago), logIndex: i, player: who === 'agent' ? AGENT : HUMAN, on: true };
  });
  return buildLiveGrid({
    hits,
    at: NOW,
    decay: { lifetimeBars: 8, maxLivePerTrack: 6 },
    agentAddress: AGENT,
    recorded,
    recordedOwner: (s, t, n) => owners.get(`${s}:${t}:${n}`) ?? 'human',
  });
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? Number.NaN;
}
