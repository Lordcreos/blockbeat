/**
 * LLM brain: asks a model for the PHRASE of the next bar (W17). The transport is injected
 * (`Completer`) so tests never touch the network; the production completers are ./openai.ts
 * (the live DJ), ./anthropic.ts and ./gemini.ts (dormant).
 *
 * W17: the model gets the section, key, progression (chord per step), a pitch table (the note
 * numbers that sound in the key), the live grid, the voices left per track and a menu: the
 * rules brain's phrase for this bar, already valid, plus the templates it came from. It answers
 * {"phrase":[{step,track,note,role}]}. The answer goes through the same gate as the rules phrase
 * (sanitizePhrase); every drop is logged with its reason and the raw answer at debug. If nothing
 * survives, the rules phrase plays, so a bad answer never costs the room a bar. W14b saw 3 in 10
 * answers of the old prompt sanitised to zero; the menu is what brings that down.
 */
import { NOTE_LIFETIME_BARS, STEPS, TRACK_META } from '@blockbeat/shared';
import { musicLabel, sectionSpec, type MusicContext } from '../music/arrangement';
import { DROP_REASONS, ROOM_HOLDS_TRACK, notesForBar, sanitizePhrase, type PhraseNote } from '../music/phrase';
import { BASS_TEMPLATES, bassNoteOf, degreePitchClass, keyName, leadNoteOf, padNoteFor, pitchClassName, type Chord } from '../music/theory';
import { renderGrid, type Grid } from '../pattern';
import { createRulesBrain, musicOf, type RulesBrain } from './rules';
import { DEFAULT_NOTES_PER_BAR, phraseEnvelopeSchema, trackLoad, type Addition, type Brain, type BrainContext, type LlmProvider, type PhraseReport } from './types';

export interface CompletionRequest {
  system: string;
  user: string;
}

/** Returns the model's JSON output, already parsed (structured outputs) but not yet validated. */
export type Completer = (request: CompletionRequest) => Promise<unknown>;

export interface LlmBrainOptions {
  complete: Completer;
  model: string;
  /** Reported as the brain mode in the status line. */
  provider: LlmProvider;
  /** The rules brain whose phrase is the menu and the fallback (share the fallback's instance so its per-cycle choices match). */
  rules?: RulesBrain;
  /** Sanitisation drops (one line per answer that lost notes). */
  log?: (message: string) => void;
  /** The raw model answer (AGENT_DEBUG_LLM=1). Never contains a key: it is the model's output. */
  debug?: (message: string) => void;
}

export const SYSTEM_PROMPT_PHRASE = [
  'You are the resident DJ of Blockbeat, a 16-step techno sequencer clocked by Monad blocks (one step = one 300 ms block, a bar = 16 steps).',
  'Each bar you play a PHRASE for the NEXT bar: up to 8 notes that work together across tracks, like a producer programming a loop, not isolated taps.',
  "Every note (yours and the room's) repeats every bar for 8 bars, then fades. A track holds at most 6 live notes. So build the arrangement over bars: backbone first, then bass, chords and melody.",
  'Follow the section: intro = sparse kick and clap; build = add hats, then the bass; peak = the full groove; breakdown = pad chords and lead only, no drums or bass.',
  'Harmony: one key and a 4-chord progression spread over the bar (one chord per 4 steps). The bass plays the root or fifth of the chord of its step, the pad plays the chord on its first step, the lead plays notes of the scale.',
  "Use only note numbers from the pitch table. Complement the humans: never target a live cell (H or A), stay off tracks held by the room, answer the room's lead in the other half of the bar.",
  'The suggested phrase is valid right now: start from it and improve it (another template, a motif variation, an answer to the room) rather than invent from nothing.',
  'Return JSON only: {"phrase":[{"step":0-15,"track":0-7,"note":0-31,"role":"kick|clap|hat|open-hat|snare-ghost|bass|pad-chord|lead-call|lead-answer|fx-sweep|fill"}]}.',
].join(' ');

function chordSpans(chords: readonly Chord[]): string {
  const width = STEPS / chords.length;
  return chords.map((c, i) => `${i * width}-${(i + 1) * width - 1} ${c.name}`).join(', ');
}

function uniqueChords(chords: readonly Chord[]): Chord[] {
  const seen = new Set<string>();
  const out: Chord[] = [];
  for (const c of chords) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}

function pitchTable(music: MusicContext): string[] {
  const chords = uniqueChords(music.chords);
  const scale = Array.from({ length: 10 }, (_, d) => `${pitchClassName(degreePitchClass(music.key, d))} ${leadNoteOf(music.key, d)}`);
  return [
    `  bass (track 4): ${chords.map((c) => `${c.name} root ${bassNoteOf(c.root)} fifth ${bassNoteOf(c.tones[2])}`).join(' · ')}; +16 = second timbre`,
    `  lead (track 5), ${keyName(music.key)} scale: ${scale.join(', ')}; +16 = second timbre`,
    `  pad (track 6): ${chords.map((c) => `${c.name} ${padNoteFor(c, music.key)}`).join(', ')}`,
    '  drums: kick (0) 10, snare ghost (1) 2, hat (2) 1, open hat (2) 25, clap (3) 11, fx sweep (7) 8',
  ];
}

const noteLabel = (n: Addition): string => `${TRACK_META[n.track]?.key ?? n.track}@${n.step} n${n.note}${n.role ? ` (${n.role})` : ''}`;

export function buildPhrasePrompt(grid: Grid, ctx: BrainContext, max: number, suggestion: readonly PhraseNote[] = []): string {
  const music = musicOf(ctx);
  const cap = grid.maxLivePerTrack > 0 ? grid.maxLivePerTrack : 6;
  const load = TRACK_META.map((t) => ({ key: t.key, ...trackLoad(grid, t.id) }));
  const held = load.filter((t) => grid.decay && t.human >= ROOM_HOLDS_TRACK).map((t) => t.key);
  const voices = load.map((t) => `${t.key} ${Math.max(0, cap - t.live - (t.human > 0 ? 1 : 0))}`).join(', ');
  return [
    `Bar ${music.bar} of the set: ${musicLabel(music)} (bar ${music.barInSection + 1} of ${music.sectionBars}).`,
    `This section plays: ${TRACK_META.filter((t) => sectionSpec(music.section).wants.has(t.id)).map((t) => t.key).join(', ')} (notes on other tracks are dropped).`,
    `Chords: steps ${chordSpans(music.chords)}.`,
    'Pitch table (note numbers):',
    ...pitchTable(music),
    "Live grid for the next bar ('.' free, 'H' human, 'A' you; columns are steps 0-15):",
    renderGrid(grid),
    `Room: ${load.reduce((n, t) => n + t.human, 0)} live human notes; held by the room: ${held.length === 0 ? 'none' : held.join(', ')}; voices you may still add: ${voices}.`,
    `Suggested phrase (valid now): ${suggestion.length === 0 ? 'none' : suggestion.map(noteLabel).join(', ')}.`,
    `Menu: bass templates ${Object.values(BASS_TEMPLATES)
      .map((t) => `${t.name} ${t.notes.map((n) => n.step).join(',')}`)
      .join(' · ')}; lead motif variations: none, transpose +2, invert, shift +1 step.`,
    `Only ${suggestion.length} target note${suggestion.length === 1 ? ' is' : 's are'} missing: never repeat a live cell, the groove there already plays. Play at most ${max} notes this bar (budget left: ${ctx.budgetLeft}); fewer is fine.`,
  ].join('\n');
}

function summarise(dropped: ReadonlyArray<{ reason: string }>): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  for (const d of dropped) out[d.reason] = (out[d.reason] ?? 0) + 1;
  return out;
}

function describeDrops(report: PhraseReport): string {
  const reasons = DROP_REASONS.filter((r) => report.dropped[r]).map((r) => `${r} ${report.dropped[r]}`);
  const parts = [reasons.join(', '), report.snapped > 0 ? `snapped ${report.snapped} to the key` : ''].filter((p) => p !== '');
  return parts.join('; ');
}

export function createLlmBrain(options: LlmBrainOptions): Brain {
  const { complete, provider, model } = options;
  const rules = options.rules ?? createRulesBrain();
  let report: PhraseReport | null = null;
  return {
    mode: provider,
    model,
    lastReport: () => report,
    async plan(grid: Grid, ctx: BrainContext): Promise<Addition[]> {
      const music = musicOf(ctx);
      const withMusic: BrainContext = { ...ctx, music };
      const max = notesForBar(grid, ctx.maxNotesPerBar ?? DEFAULT_NOTES_PER_BAR, ctx.budgetLeft);
      const suggestion = rules.compose(grid, withMusic).kept;
      // Nothing the section needs this bar (or no budget): no call, no latency, no cost.
      if (max === 0 || suggestion.length === 0) return [];
      const raw = await complete({ system: SYSTEM_PROMPT_PHRASE, user: buildPhrasePrompt(grid, withMusic, max, suggestion) });
      options.debug?.(`${provider} raw answer: ${JSON.stringify(raw)}`);
      const parsed = phraseEnvelopeSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`LLM output failed schema validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      const lifetimeBars = grid.decay ? (ctx.lifetimeBars ?? NOTE_LIFETIME_BARS) : 0;
      const cleaned = sanitizePhrase(parsed.data.phrase, grid, music, { maxNotes: max, lifetimeBars });
      report = { raw: parsed.data.phrase.length, kept: cleaned.kept.length, dropped: summarise(cleaned.dropped), snapped: cleaned.snapped, sanitisedToZero: cleaned.kept.length === 0 };
      if (cleaned.dropped.length > 0 || cleaned.snapped > 0) options.log?.(`${provider} phrase: kept ${report.kept}/${report.raw} (${describeDrops(report)})`);
      if (cleaned.kept.length === 0) {
        options.log?.(`${provider} phrase sanitised to zero (${report.raw} notes answered); playing the rules phrase (${suggestion.length} notes)`);
        return suggestion;
      }
      return cleaned.kept;
    },
  };
}
