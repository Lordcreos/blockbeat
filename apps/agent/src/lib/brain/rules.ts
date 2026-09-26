/**
 * Deterministic rule-based brain. Used when there is no LLM key or the API fails, so it must
 * sound like a track on its own.
 *
 * W17: it plays PHRASES. The section clock (music/arrangement.ts) says where the set is (intro,
 * build, peak, breakdown), the theory module (music/theory.ts) turns the section into a target
 * arrangement in the key (drums, a bass line on the chord of each step, pad chords, a lead motif
 * answering the room), and each bar the phrase is the up-to-8 most important target notes the live
 * grid is missing (music/phrase.ts), through the same gate as any LLM phrase.
 *
 * The per-cycle choices (bass template, motif variation, call-and-response half) are held for the
 * whole 20-bar cycle, so a track's target never changes under notes that ring for 8 bars.
 */
import { NOTE_LIFETIME_BARS } from '@blockbeat/shared';
import type { Grid } from '../pattern';
import { musicAt, type MusicContext } from '../music/arrangement';
import { chooseSection, composePhrase, type SanitizeReport, type SectionChoices } from '../music/phrase';
import { DEFAULT_NOTES_PER_BAR, type Addition, type Brain, type BrainContext } from './types';

export interface RulesBrain extends Brain {
  /** The rules phrase and its sanitisation for a bar; the LLM brain uses it as its menu and fallback. */
  compose(grid: Grid, ctx: BrainContext): SanitizeReport;
}

export function musicOf(ctx: BrainContext): MusicContext {
  return ctx.music ?? musicAt(ctx.bar);
}

export function createRulesBrain(): RulesBrain {
  const held = new Map<number, SectionChoices>();

  function choicesFor(music: MusicContext, grid: Grid): SectionChoices {
    // The lead half is only heard from the peak on: fix it there, for the rest of the cycle.
    const kept = held.get(music.cycle);
    if (kept) return kept;
    const fresh = chooseSection(music, grid);
    if (music.section !== 'peak' && music.section !== 'breakdown') return fresh;
    held.set(music.cycle, fresh);
    for (const cycle of held.keys()) if (cycle < music.cycle - 1) held.delete(cycle);
    return fresh;
  }

  function compose(grid: Grid, ctx: BrainContext): SanitizeReport {
    const music = musicOf(ctx);
    return composePhrase(grid, music, {
      maxNotesPerBar: ctx.maxNotesPerBar ?? DEFAULT_NOTES_PER_BAR,
      budgetLeft: ctx.budgetLeft,
      lifetimeBars: grid.decay ? (ctx.lifetimeBars ?? NOTE_LIFETIME_BARS) : 0,
      choices: choicesFor(music, grid),
    });
  }

  return {
    mode: 'rules',
    compose,
    async plan(grid: Grid, ctx: BrainContext): Promise<Addition[]> {
      return compose(grid, ctx).kept;
    },
  };
}
