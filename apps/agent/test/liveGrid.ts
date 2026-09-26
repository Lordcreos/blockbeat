/**
 * Test helpers: live grids from synthetic hits, and a small room simulator that replays the
 * DJ's own phrases through the shared live layer (decay and voice cap) bar after bar.
 */
import { STEPS, emptyPattern, toggle, type LiveHit, type TrackId } from '@blockbeat/shared';
import type { Addition } from '../src/lib/brain/types';
import { buildLiveGrid, type DecaySettings, type Grid } from '../src/lib/pattern';

export const AGENT = '0x2222222222222222222222222222222222222222' as const;
export const HUMAN = '0x1111111111111111111111111111111111111111' as const;
export const DECAY: DecaySettings = { lifetimeBars: 8, maxLivePerTrack: 6 };

export type Spec = [step: number, track: TrackId, note: number, ago: number, who?: 'human' | 'agent'];

/** A live grid at `now` from hits `ago` blocks back; every hit is also toggled into the recorded pattern. */
export function liveGrid(specs: Spec[], now = 10_000n, decay: DecaySettings = DECAY): Grid {
  const recorded = emptyPattern();
  const owners = new Map<string, 'human' | 'agent'>();
  const hits: LiveHit[] = specs.map(([step, track, note, ago, who], i) => {
    recorded[step] = toggle(recorded[step] ?? 0n, track, note);
    owners.set(`${step}:${track}:${note}`, who ?? 'human');
    return { step, track, note, blockNumber: now - BigInt(ago), logIndex: i, player: who === 'agent' ? AGENT : HUMAN, on: true };
  });
  return buildLiveGrid({ hits, at: now, decay, agentAddress: AGENT, recorded, recordedOwner: (s, t, n) => owners.get(`${s}:${t}:${n}`) ?? 'human' });
}

export interface Room {
  /** The live grid at the start of bar `bar` (block START + bar × 16). */
  gridAt(bar: number): Grid;
  /** Land notes in bar `bar`, each on its own step. */
  play(bar: number, notes: readonly Addition[], who?: 'human' | 'agent'): void;
  hits(): readonly LiveHit[];
}

const START = 1_600n;

export function createRoom(decay: DecaySettings = DECAY): Room {
  const hits: LiveHit[] = [];
  const recorded = emptyPattern();
  const owners = new Map<string, 'human' | 'agent'>();
  return {
    gridAt(bar) {
      return buildLiveGrid({
        hits,
        at: START + BigInt(bar * STEPS),
        decay,
        agentAddress: AGENT,
        recorded: [...recorded],
        recordedOwner: (s, t, n) => owners.get(`${s}:${t}:${n}`) ?? 'human',
      });
    },
    play(bar, notes, who = 'agent') {
      for (const n of notes) {
        const key = `${n.step}:${n.track}:${n.note}`;
        recorded[n.step] = toggle(recorded[n.step] ?? 0n, n.track, n.note);
        owners.set(key, who);
        hits.push({ step: n.step, track: n.track, note: n.note, blockNumber: START + BigInt(bar * STEPS + n.step), logIndex: hits.length, player: who === 'agent' ? AGENT : HUMAN, on: true });
      }
    },
    hits: () => hits,
  };
}
