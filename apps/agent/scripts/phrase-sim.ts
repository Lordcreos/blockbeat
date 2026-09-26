/**
 * W17 evidence helper (pure, no audio): play N bars of the rules DJ into an empty room through
 * the shared live layer (decay 8 bars, 6 voices per track), exactly as the stage evaluates it,
 * and return each bar's phrase plus every note that sounds on every step.
 */
import { MAX_LIVE_PER_TRACK, NOTE_LIFETIME_BARS, STEPS, TRACK_META, emptyPattern, livePattern, toggle, type LiveHit, type TrackId } from '@blockbeat/shared';
import { createRulesBrain } from '../src/lib/brain/rules';
import { musicAt, musicLabel } from '../src/lib/music/arrangement';
import { buildLiveGrid } from '../src/lib/pattern';

const AGENT = '0x2222222222222222222222222222222222222222' as const;
const START = 1_600n;

export interface SimBar {
  bar: number;
  section: string;
  label: string;
  phrase: Array<{ step: number; track: TrackId; note: number; role: string }>;
  /** Notes that sound during the bar, per step. */
  sounding: Array<Array<{ track: TrackId; note: number }>>;
  liveAtStart: number;
}

export async function simulateSet(bars: number): Promise<SimBar[]> {
  const brain = createRulesBrain();
  const hits: LiveHit[] = [];
  let recorded = emptyPattern();
  const out: SimBar[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const at = START + BigInt(bar * STEPS);
    const grid = buildLiveGrid({ hits, at, decay: { lifetimeBars: NOTE_LIFETIME_BARS, maxLivePerTrack: MAX_LIVE_PER_TRACK }, agentAddress: AGENT, recorded, recordedOwner: () => 'agent' });
    const music = musicAt(bar);
    const phrase = await brain.plan(grid, { bar, budgetLeft: 10_000, music, maxNotesPerBar: 8, lifetimeBars: NOTE_LIFETIME_BARS });
    for (const n of phrase) {
      recorded = [...recorded];
      recorded[n.step] = toggle(recorded[n.step] ?? 0n, n.track, n.note);
      hits.push({ step: n.step, track: n.track, note: n.note, blockNumber: at + BigInt(n.step), logIndex: hits.length, player: AGENT, on: true });
    }
    // What the stage plays on each step: the live layer at that step's block.
    const sounding = Array.from({ length: STEPS }, (_, step) => {
      const live = livePattern(hits, at + BigInt(step), NOTE_LIFETIME_BARS, { maxLivePerTrack: MAX_LIVE_PER_TRACK });
      return live.cells.filter((c) => c.step === step).map((c) => ({ track: c.track, note: c.note }));
    });
    out.push({ bar, section: music.section, label: musicLabel(music), phrase: phrase.map((a) => ({ step: a.step, track: a.track, note: a.note, role: a.role ?? 'fill' })), sounding, liveAtStart: grid.cells.length });
  }
  return out;
}

/** A markdown table of the arrangement: per bar the section, the phrase by track, and what sounds. */
export function arrangementTable(sim: readonly SimBar[]): string {
  const rows = sim.map((b) => {
    const byTrack = new Map<string, number[]>();
    for (const n of b.phrase) {
      const key = TRACK_META[n.track]?.key ?? String(n.track);
      byTrack.set(key, [...(byTrack.get(key) ?? []), n.step]);
    }
    const phrase = b.phrase.length === 0 ? '(none: the groove holds)' : [...byTrack.entries()].map(([k, steps]) => `${k} ${steps.join(',')}`).join(' · ');
    const tracks = new Set(b.sounding.flat().map((c) => TRACK_META[c.track]?.key ?? String(c.track)));
    const notes = b.sounding.reduce((n, s) => n + s.length, 0);
    return `| ${b.bar + 1} | ${b.section} | ${b.phrase.length} | ${phrase} | ${notes} | ${[...tracks].join(', ')} |`;
  });
  return ['| Bar | Section | DJ notes | Phrase (track steps) | Notes heard in the bar | Tracks heard |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}
