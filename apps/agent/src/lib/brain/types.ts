import { NOTES_PER_TRACK, STEPS, TRACKS, type TrackId } from '@blockbeat/shared';
import { z } from 'zod';
import type { MusicContext } from '../music/arrangement';
import { PHRASE_ROLES } from '../music/phrase';
import type { Grid } from '../pattern';

/** One note of the phrase the agent plays in the next bar. */
export interface Addition {
  step: number;
  track: TrackId;
  note: number;
  /** W17: the musical role in the phrase (kick, bass, pad-chord, lead-call, …); logs and prompts only. */
  role?: string;
  /** W17: re-lights the DJ's own expiring note on the same cell; the hit clears its recorded bit (expected). */
  refresh?: boolean;
}

export interface BrainContext {
  /** Bar index since the session start (informational). */
  bar: number;
  /** Hits the agent may still send this session. */
  budgetLeft: number;
  /** W17: section, key and progression of the planned bar; derived from `bar` when absent. */
  music?: MusicContext;
  /** W17: AGENT_MAX_NOTES_PER_BAR (default DEFAULT_NOTES_PER_BAR). */
  maxNotesPerBar?: number;
  /** W17: note lifetime in bars (0 = no decay); default NOTE_LIFETIME_BARS. */
  lifetimeBars?: number;
}

/** Which brain planned the bar; the status line prints it (W12: the LLM brains name their provider; W14: gemini). */
export type BrainMode = 'anthropic' | 'gemini' | 'openai' | 'rules';
export type LlmProvider = Exclude<BrainMode, 'rules'>;

/** W17: how an LLM answer fared in sanitisation (the latency script reports the sanitised-to-zero rate from it). */
export interface PhraseReport {
  /** Notes the model returned. */
  raw: number;
  /** Notes that passed the gate. */
  kept: number;
  dropped: Partial<Record<string, number>>;
  snapped: number;
  /** The model answered notes, none survived, and the rules phrase played instead. */
  sanitisedToZero: boolean;
}

export interface Brain {
  readonly mode: BrainMode;
  /** W14: the model id an LLM brain runs on (shown in the status line); absent for the rules. */
  readonly model?: string;
  plan(grid: Grid, ctx: BrainContext): Promise<Addition[]>;
  /** W17, LLM brains: the sanitisation of the last answer (null before the first call). */
  lastReport?(): PhraseReport | null;
}

/** W17: a phrase has at most 8 notes (the JSON schema's hard limit; AGENT_MAX_NOTES_PER_BAR may lower it). */
export const MAX_PHRASE_NOTES = 8;
export const DEFAULT_NOTES_PER_BAR = 8;

/** Live notes on a track, and how many of them a human hit last. */
export function trackLoad(grid: Grid, track: number): { live: number; human: number } {
  let live = 0;
  let human = 0;
  for (const c of grid.cells) {
    if (c.track !== track) continue;
    live += 1;
    if (c.owner === 'human') human += 1;
  }
  return { live, human };
}

/** One phrase note as the LLM returns it (W17). */
export const phraseNoteSchema = z.object({
  step: z.number().int().min(0).max(STEPS - 1),
  track: z.number().int().min(0).max(TRACKS - 1),
  note: z.number().int().min(0).max(NOTES_PER_TRACK - 1),
  role: z.enum(PHRASE_ROLES),
});

/** JSON-only output contract handed to the Anthropic API as the structured-output format. */
export const phraseSchema = z.object({
  phrase: z.array(phraseNoteSchema).max(MAX_PHRASE_NOTES),
});

/**
 * The same contract as a plain JSON Schema for OpenAI strict structured outputs and Gemini:
 * every property required, no additional properties. Kept next to phraseSchema so they cannot drift.
 */
export const PHRASE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['phrase'],
  properties: {
    phrase: {
      type: 'array',
      maxItems: MAX_PHRASE_NOTES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'track', 'note', 'role'],
        properties: {
          step: { type: 'integer', minimum: 0, maximum: STEPS - 1 },
          track: { type: 'integer', minimum: 0, maximum: TRACKS - 1 },
          note: { type: 'integer', minimum: 0, maximum: NOTES_PER_TRACK - 1 },
          role: { type: 'string', enum: [...PHRASE_ROLES] },
        },
      },
    },
  },
} as const;

export type Phrase = z.infer<typeof phraseSchema>;

/**
 * Shape check applied to whatever comes back: the envelope must be right, but a single
 * out-of-range entry only drops that entry (sanitizePhrase), not the whole bar.
 */
export const phraseEnvelopeSchema = z.object({
  phrase: z.array(z.unknown()),
});
