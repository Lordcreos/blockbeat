/**
 * Brain contract (W17: every brain returns a PHRASE per bar), the rules brain, the LLM brain
 * with mocked completers, and the fallback labels (W14).
 */
import { describe, expect, it, vi } from 'vitest';
import { emptyPattern, toggle, type TrackId } from '@blockbeat/shared';
import { liveGrid, type Spec } from '../../../test/liveGrid';
import { musicAt } from '../music/arrangement';
import { isInKey, A_MINOR } from '../music/theory';
import { buildGrid, type Grid } from '../pattern';
import { createFallbackBrain } from './fallback';
import { SYSTEM_PROMPT_PHRASE, buildPhrasePrompt, createLlmBrain, type Completer } from './llm';
import { createRulesBrain } from './rules';
import { MAX_PHRASE_NOTES, PHRASE_JSON_SCHEMA, type Addition, type Brain, type BrainContext } from './types';

const ctxAt = (bar: number, budgetLeft = 160): BrainContext => ({ bar, budgetLeft, music: musicAt(bar), maxNotesPerBar: 8, lifetimeBars: 8 });

const FIXTURES = {
  empty: liveGrid([]),
  /** A room playing kick and a lead line early in the bar. */
  room: liveGrid([
    [0, 0, 10, 20],
    [1, 5, 3, 30],
    [3, 5, 7, 30],
    [9, 2, 1, 40],
  ]),
  /** Six human hats: the hat track is full, the room holds it. */
  hatsFull: liveGrid(Array.from({ length: 6 }, (_, i): Spec => [i * 2, 2, 1, 10])),
};

/** A canned completer that answers like a slightly sloppy model: valid, duplicate, off-key and invalid entries. */
const sloppyCompleter: Completer = async () => ({
  phrase: [
    { step: 0, track: 0, note: 10, role: 'kick' },
    { step: 0, track: 0, note: 10, role: 'kick' }, // duplicate cell
    { step: 4, track: 4, note: 9, role: 'bass' }, // F# is off key: snapped to F (8)
    { step: 8, track: 0, note: 10, role: 'kick' },
    { step: 20, track: 5, note: 0, role: 'lead-call' }, // out of range
    { step: 6, track: 6, note: 40, role: 'pad-chord' }, // bad note
    { step: 4, track: 3, note: 11, role: 'clap' },
    { step: 12, track: 3, note: 11, role: 'clap' },
  ],
});

const brains: Array<[string, () => Brain]> = [
  ['rules', () => createRulesBrain()],
  ['anthropic', () => createLlmBrain({ complete: sloppyCompleter, model: 'claude-sonnet-5', provider: 'anthropic' })],
  ['openai', () => createLlmBrain({ complete: sloppyCompleter, model: 'gpt-6-luna', provider: 'openai' })],
  ['gemini', () => createLlmBrain({ complete: sloppyCompleter, model: 'gemini-3.6-flash', provider: 'gemini' })],
];

function assertPhrase(grid: Grid, out: readonly Addition[], max: number): void {
  expect(out.length).toBeLessThanOrEqual(max);
  const cells = new Set<string>();
  for (const a of out) {
    expect(a.step).toBeGreaterThanOrEqual(0);
    expect(a.step).toBeLessThan(16);
    expect(a.note).toBeGreaterThanOrEqual(0);
    expect(a.note).toBeLessThan(32);
    expect(isInKey(a.track, a.note, A_MINOR)).toBe(true);
    expect(grid.isOn(a.step, a.track)).toBe(false);
    expect(cells.has(`${a.step}:${a.track}`)).toBe(false);
    cells.add(`${a.step}:${a.track}`);
    expect(typeof a.role).toBe('string');
  }
  for (let t = 0; t < 8; t++) {
    const live = grid.cells.filter((c) => c.track === t).length;
    const added = out.filter((a) => a.track === t).length;
    expect(live + added).toBeLessThanOrEqual(6);
  }
}

describe.each(brains)('brain contract (W17 phrases): %s', (_name, make) => {
  it('returns a phrase of up to 8 notes, in key, on free cells, within the voice cap', async () => {
    for (const [grid, bar] of [
      [FIXTURES.empty, 0],
      [FIXTURES.room, 8],
      [FIXTURES.hatsFull, 9],
    ] as const) {
      assertPhrase(grid, await make().plan(grid, ctxAt(bar)), MAX_PHRASE_NOTES);
    }
  });

  it('never plays on a track the room holds', async () => {
    const out = await make().plan(FIXTURES.hatsFull, ctxAt(9));
    expect(out.some((a) => a.track === 2)).toBe(false);
  });

  it('respects the budget and the per-bar cap', async () => {
    expect((await make().plan(FIXTURES.empty, ctxAt(8, 2))).length).toBeLessThanOrEqual(2);
    expect(await make().plan(FIXTURES.empty, ctxAt(8, 0))).toEqual([]);
    expect((await make().plan(FIXTURES.empty, { ...ctxAt(8), maxNotesPerBar: 3 })).length).toBeLessThanOrEqual(3);
  });

  it('is deterministic for the same grid and bar', async () => {
    expect(await make().plan(FIXTURES.room, ctxAt(10))).toEqual(await make().plan(FIXTURES.room, ctxAt(10)));
  });
});

describe('rules brain', () => {
  it('reports mode rules and plays the section phrase', async () => {
    const brain = createRulesBrain();
    expect(brain.mode).toBe('rules');
    expect((await brain.plan(FIXTURES.empty, ctxAt(0))).map((a) => a.role)).toEqual(['kick', 'kick', 'clap', 'clap']);
    const peak = await brain.plan(FIXTURES.empty, ctxAt(8));
    expect(peak.length).toBe(8);
    expect(new Set(peak.map((a) => a.track)).size).toBeGreaterThanOrEqual(3);
  });

  it('works out the music from the bar when the context has none', async () => {
    expect(await createRulesBrain().plan(FIXTURES.empty, { bar: 8, budgetLeft: 160 })).toEqual(await createRulesBrain().plan(FIXTURES.empty, ctxAt(8)));
  });

  it('holds the call-and-response half for the whole cycle, although the room moves', async () => {
    const brain = createRulesBrain();
    const early = await brain.plan(FIXTURES.room, ctxAt(9)); // room lead early: DJ answers late
    const lateRoom = liveGrid([
      [12, 5, 3, 30],
      [14, 5, 7, 30],
    ]);
    const later = await brain.plan(lateRoom, ctxAt(16));
    const leadSteps = [...early, ...later].filter((a) => a.role === 'lead-call').map((a) => a.step);
    expect(leadSteps.length).toBeGreaterThan(0);
    expect(leadSteps.every((s) => s >= 8)).toBe(true);
  });

  it('plays on a recorded grid (decay off) without toggling a note off', async () => {
    const p = emptyPattern();
    for (const [s, t] of [
      [0, 0],
      [8, 0],
    ] as Array<[number, TrackId]>) p[s] = toggle(p[s] ?? 0n, t, 10);
    const recorded = buildGrid(p, () => 'human');
    const out = await createRulesBrain().plan(recorded, ctxAt(0));
    expect(out.some((a) => a.track === 0 && (a.step === 0 || a.step === 8))).toBe(false);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('llm brain', () => {
  it('sends the section, key, progression, pitch table, live grid and the suggested phrase; returns the cleaned phrase', async () => {
    const complete = vi.fn<Completer>(async () => ({ phrase: [{ step: 4, track: 3, note: 11, role: 'clap' }] }));
    const brain = createLlmBrain({ complete, model: 'gpt-6-luna', provider: 'openai' });
    expect(brain.mode).toBe('openai');
    const out = await brain.plan(FIXTURES.room, ctxAt(5));
    expect(out).toEqual([{ step: 4, track: 3, note: 11, role: 'clap' }]);
    const call = complete.mock.calls[0]?.[0];
    expect(call?.system).toBe(SYSTEM_PROMPT_PHRASE);
    expect(call?.system).toMatch(/phrase/i);
    expect(call?.system).toMatch(/8 bars/);
    expect(call?.user).toContain('section build · A minor · Am-F-C-G');
    expect(call?.user).toContain('steps 0-3 Am, 4-7 F, 8-11 C, 12-15 G');
    expect(call?.user).toMatch(/bass \(track 4\).*Am root 0/);
    expect(call?.user).toContain('pad (track 6): Am 0, F 5, C 11, G 7');
    expect(call?.user).toContain('kick  H');
    expect(call?.user).toMatch(/Suggested phrase.*kick@4 n10/);
    expect(call?.user).toMatch(/at most 8 notes/);
    // Testnet session 8: with 1 note missing, Luna restated the live groove (kept 1/8). Say how many are missing.
    expect(call?.user).toMatch(/Only \d+ target notes? (is|are) missing: never repeat a live cell/);
    expect(call?.user).toContain('This section plays: kick, hat, clap, bass (notes on other tracks are dropped).');
  });

  it('is not called when the section needs nothing this bar', async () => {
    const complete = vi.fn<Completer>(async () => ({ phrase: [] }));
    const full = liveGrid([
      [0, 0, 10, 20, 'agent'],
      [8, 0, 10, 20, 'agent'],
      [4, 3, 11, 20, 'agent'],
      [12, 3, 11, 20, 'agent'],
    ]);
    expect(await createLlmBrain({ complete, model: 'm', provider: 'openai' }).plan(full, ctxAt(1))).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('logs what sanitisation dropped, with reasons, and the raw answer at debug', async () => {
    const log = vi.fn<(m: string) => void>();
    const debug = vi.fn<(m: string) => void>();
    const brain = createLlmBrain({ complete: sloppyCompleter, model: 'gpt-6-luna', provider: 'openai', log, debug });
    const out = await brain.plan(FIXTURES.empty, ctxAt(8));
    expect(out.map((a) => `${a.track}@${a.step}n${a.note}`)).toEqual(['0@0n10', '4@4n8', '0@8n10', '3@4n11', '3@12n11']);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/openai phrase: kept 5\/8.*invalid 2.*duplicate 1.*snapped 1/));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('"phrase"'));
    expect(brain.lastReport?.()).toMatchObject({ raw: 8, kept: 5, sanitisedToZero: false });
  });

  it('plays the rules phrase when the answer is sanitised to zero, and says so', async () => {
    const log = vi.fn<(m: string) => void>();
    const complete: Completer = async () => ({ phrase: [{ step: 0, track: 0, note: 10, role: 'kick' }] });
    const occupied = liveGrid([[0, 0, 10, 20, 'agent']]);
    const brain = createLlmBrain({ complete, model: 'gpt-6-luna', provider: 'openai', log });
    const out = await brain.plan(occupied, ctxAt(0));
    expect(out.map((a) => `${a.role}@${a.step}`)).toEqual(['kick@8', 'clap@4', 'clap@12']);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/sanitised to zero.*rules phrase/));
    expect(brain.lastReport?.()).toMatchObject({ raw: 1, kept: 0, sanitisedToZero: true });
  });

  it('rejects output that is not the phrase shape', async () => {
    const brain = createLlmBrain({ complete: async () => ({ additions: [] }), model: 'claude-sonnet-5', provider: 'anthropic' });
    await expect(brain.plan(FIXTURES.empty, ctxAt(0))).rejects.toThrow(/schema/i);
  });

  it('propagates completer errors', async () => {
    const brain = createLlmBrain({
      complete: async () => {
        throw new Error('429 rate limited');
      },
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    });
    await expect(brain.plan(FIXTURES.empty, ctxAt(0))).rejects.toThrow('429');
  });

  it('the JSON schema allows at most 8 notes, each with a known role, and nothing else', () => {
    expect(PHRASE_JSON_SCHEMA.properties.phrase.maxItems).toBe(8);
    expect(PHRASE_JSON_SCHEMA.properties.phrase.items.properties.role.enum).toContain('bass');
    expect(PHRASE_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('keeps the prompt compact (latency)', () => {
    const user = buildPhrasePrompt(FIXTURES.room, ctxAt(9), 8);
    expect(user.length).toBeLessThan(3500);
    expect(SYSTEM_PROMPT_PHRASE.length).toBeLessThan(2000);
  });
});

describe('fallback brain', () => {
  it('uses the primary when it works and reports its mode', async () => {
    const primary = createLlmBrain({ complete: sloppyCompleter, model: 'claude-sonnet-5', provider: 'anthropic' });
    const brain = createFallbackBrain({ primary, fallback: createRulesBrain(), warn: () => undefined });
    const out = await brain.plan(FIXTURES.empty, ctxAt(8));
    expect(out.length).toBeGreaterThan(0);
    expect(brain.lastMode()).toBe('anthropic');
  });

  it('falls back to rules when the primary fails, and warns with the reason', async () => {
    const warn = vi.fn();
    const primary = createLlmBrain({
      complete: async () => {
        throw new Error('timeout');
      },
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    });
    const brain = createFallbackBrain({ primary, fallback: createRulesBrain(), warn });
    const out = await brain.plan(FIXTURES.empty, ctxAt(0));
    expect(out.length).toBeGreaterThan(0);
    expect(brain.lastMode()).toBe('rules');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
  });

  it('runs rules only when there is no primary', async () => {
    const brain = createFallbackBrain({ primary: null, fallback: createRulesBrain(), warn: () => undefined });
    await brain.plan(FIXTURES.empty, ctxAt(0));
    expect(brain.lastMode()).toBe('rules');
    expect(brain.mode).toBe('rules');
    expect(brain.lastLabel()).toBe('rules');
  });

  it('W14b: labels OpenAI failures the same way', async () => {
    let fail: Error = new Error('x');
    const primary = createLlmBrain({ complete: async () => { throw fail; }, model: 'gpt-6-luna', provider: 'openai' });
    const brain = createFallbackBrain({ primary, fallback: createRulesBrain(), warn: () => undefined });
    expect(brain.lastLabel()).toBe('openai gpt-6-luna');
    const cases: Array<[string, string]> = [
      ['openai request timed out after 4000 ms', 'rules (openai timeout)'],
      ['openai 429: Rate limit reached', 'rules (openai http 429)'],
      ['openai 502: non-JSON body', 'rules (openai http 502)'],
      ['openai 401: Incorrect API key provided', 'rules (openai unavailable: no access)'],
      ['openai 404: The model does not exist', 'rules (openai unavailable: model not found)'],
      ['openai 400: Unsupported value reasoning.effort', 'rules (openai unavailable: bad request)'],
      ['openai response incomplete (max_output_tokens)', 'rules (openai bad output)'],
    ];
    for (const [message, label] of cases) {
      fail = new Error(message);
      await brain.plan(FIXTURES.empty, ctxAt(0));
      expect(brain.lastLabel()).toBe(label);
    }
  });

  it('labels the bar with the provider and model, or rules with the failure class (W14)', async () => {
    let fail: Error | null = null;
    const primary = createLlmBrain({
      complete: async (r) => {
        if (fail) throw fail;
        return sloppyCompleter(r);
      },
      model: 'gemini-3.8-flash',
      provider: 'gemini',
    });
    const brain = createFallbackBrain({ primary, fallback: createRulesBrain(), warn: () => undefined });
    expect(brain.lastLabel()).toBe('gemini gemini-3.8-flash');
    const ctx = ctxAt(0);
    await brain.plan(FIXTURES.empty, ctx);
    expect(brain.lastLabel()).toBe('gemini gemini-3.8-flash');
    const cases: Array<[Error, string]> = [
      [new Error('gemini request timed out after 4000 ms'), 'rules (gemini timeout)'],
      [new Error('gemini 429: quota exceeded'), 'rules (gemini http 429)'],
      [new Error('gemini 503: overloaded'), 'rules (gemini http 503)'],
      [new Error('model refused (SAFETY)'), 'rules (gemini refusal)'],
      [new Error('LLM output failed schema validation: x'), 'rules (gemini bad output)'],
      [new Error('could not parse model output as JSON (x)'), 'rules (gemini bad output)'],
      [new Error('gemini response incomplete (MAX_TOKENS)'), 'rules (gemini bad output)'],
      [new Error('gemini 404: '), 'rules (gemini unavailable: model not found)'],
      [new Error('gemini rate cap (5/min)'), 'rules (gemini rate cap)'],
      [new Error('gemini 400: {"error":{"code":400,"message":"API key not valid. Please pass a valid API key."}}'), 'rules (gemini unavailable: invalid key)'],
      [new Error('gemini 400: bad schema field'), 'rules (gemini unavailable: bad request)'],
      [new Error('gemini 401: unauthenticated'), 'rules (gemini unavailable: no access)'],
      [new Error('gemini 403: permission denied'), 'rules (gemini unavailable: no access)'],
      [new Error('gemini request failed: fetch failed'), 'rules (gemini network)'],
      [new Error('gemini request failed: connect ECONNREFUSED 1.2.3.4:443'), 'rules (gemini network)'],
      [new Error('429 {"type":"rate_limit_error"}'), 'rules (gemini http 429)'],
      [new Error('LLM output failed schema validation: 500 tokens over the limit'), 'rules (gemini bad output)'],
      [new Error('something odd, key AIza-secret'), 'rules (gemini error)'],
    ];
    for (const [error, label] of cases) {
      fail = error;
      await brain.plan(FIXTURES.empty, ctx);
      expect(brain.lastLabel()).toBe(label);
      expect(brain.lastMode()).toBe('rules');
    }
    fail = null;
    await brain.plan(FIXTURES.empty, ctx);
    expect(brain.lastLabel()).toBe('gemini gemini-3.8-flash');
  });
});
