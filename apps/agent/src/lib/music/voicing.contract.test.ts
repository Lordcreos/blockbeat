/**
 * W17 contract check: the DJ composes with @blockbeat/shared voicing.ts, the stage plays with
 * apps/web/lib/audio/kitSpec.ts (its own copy; apps/web is imported read-only here). If they ever
 * drift, the DJ would play out of key without a single test failing anywhere else.
 */
import { describe, expect, it } from 'vitest';
import { NOTES_PER_TRACK, PAD_CHORD_INTERVALS, padVoicingOf, pitchedMidiOf } from '@blockbeat/shared';
import { PAD_CHORDS, midiToHz, noteVariant } from '../../../../web/lib/audio/kitSpec';

const notes = Array.from({ length: NOTES_PER_TRACK }, (_, n) => n);

describe('shared voicing = the stage kit', () => {
  it('bass and lead: every note sounds the pitch the DJ computes', () => {
    for (const track of [4, 5] as const) {
      for (const n of notes) expect(noteVariant(track, n).pitchHz).toBeCloseTo(midiToHz(pitchedMidiOf(track, n)), 6);
    }
  });

  it('pad: every note has the root and chord type the DJ computes', () => {
    expect(PAD_CHORDS.map((c) => [...c])).toEqual(PAD_CHORD_INTERVALS.map((c) => [...c]));
    for (const n of notes) expect(noteVariant(6, n).pitchHz).toBeCloseTo(midiToHz(padVoicingOf(n).rootMidi), 6);
    for (const n of notes) expect(PAD_CHORDS[noteVariant(6, n).timbre]).toEqual(padVoicingOf(n).intervals);
  });
});
