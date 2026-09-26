/**
 * W14b / W17 evidence helper: time N real DJ calls to the OpenAI Responses API through the
 * production path (createOpenAiCompleter + createLlmBrain with the W17 phrase prompt) on the
 * realistic live grid, and report how the answers fared in sanitisation.
 *
 *   pnpm --filter agent exec tsx scripts/openai-latency.ts [--model gpt-6-luna] [--effort none] [--n 10] [--gap-ms 0]
 *
 * The calls walk through the sections (intro, build, peak, late peak, breakdown) so the rate
 * covers every kind of phrase. `sanitisedToZero` counts answers that kept no note (the old prompt:
 * 3 of 10). The raw model answer of every call is kept in the JSON (it is model output, never a
 * key). The key comes from OPENAI_API_KEY (apps/agent/.env) and is never printed. The timeout here
 * is 15 s so the true latency is measured, not the agent's 4 s deadline.
 */
import 'dotenv/config';
import { musicAt } from '../src/lib/music/arrangement';
import { notesForBar } from '../src/lib/music/phrase';
import { createOpenAiCompleter } from '../src/lib/brain/openai';
import { createLlmBrain, buildPhrasePrompt, type Completer } from '../src/lib/brain/llm';
import { createRulesBrain } from '../src/lib/brain/rules';
import type { PhraseReport } from '../src/lib/brain/types';
import { percentile, realisticGrid } from './latency-fixture';

/** One bar from each part of the set, twice over. */
const BARS = [0, 5, 6, 8, 9, 12, 16, 17, 10, 7] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Run {
  i: number;
  bar: number;
  section: string;
  ms: number;
  ok: boolean;
  called: boolean;
  notes: number;
  report?: PhraseReport | null;
  plan?: string;
  raw?: unknown;
  error?: string;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('set OPENAI_API_KEY in apps/agent/.env');
  const model = arg('--model') ?? 'gpt-6-luna';
  const effort = arg('--effort') ?? 'none';
  const n = Number(arg('--n') ?? '10');
  const gapMs = Number(arg('--gap-ms') ?? '0');
  const grid = realisticGrid();
  const openai = createOpenAiCompleter({ apiKey, model, timeoutMs: 15_000, reasoningEffort: effort === 'default' ? null : effort });
  let lastRaw: unknown;
  let called = false;
  const complete: Completer = async (request) => {
    called = true;
    lastRaw = await openai(request);
    return lastRaw;
  };
  const drops: string[] = [];
  const brain = createLlmBrain({ complete, model, provider: 'openai', rules: createRulesBrain(), log: (m) => drops.push(m) });
  const runs: Run[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    const bar = BARS[i % BARS.length] ?? 8;
    const music = musicAt(bar);
    called = false;
    lastRaw = undefined;
    const t0 = performance.now();
    try {
      const out = await brain.plan(grid, { bar, budgetLeft: 160, music, maxNotesPerBar: 8, lifetimeBars: 8 });
      runs.push({
        i,
        bar,
        section: music.section,
        ms: Math.round(performance.now() - t0),
        ok: true,
        called,
        notes: out.length,
        report: called ? (brain.lastReport?.() ?? null) : null,
        plan: out.map((a) => `t${a.track}@${a.step}n${a.note}(${a.role ?? '?'})`).join(' '),
        raw: lastRaw,
      });
    } catch (error) {
      // Recorded, not swallowed: a failed call is a data point (and would be a rules bar live).
      runs.push({ i, bar, section: music.section, ms: Math.round(performance.now() - t0), ok: false, called, notes: 0, raw: lastRaw, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
    }
  }
  const asked = runs.filter((r) => r.called);
  const okMs = asked.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const allMs = asked.map((r) => r.ms).sort((a, b) => a - b);
  const zero = asked.filter((r) => r.report?.sanitisedToZero).length;
  const kept = asked.reduce((s, r) => s + (r.report?.kept ?? 0), 0);
  const answered = asked.reduce((s, r) => s + (r.report?.raw ?? 0), 0);
  const summary = {
    model,
    effort,
    n,
    gapMs,
    called: asked.length,
    ok: okMs.length,
    liveNotes: grid.cells.length,
    p50: percentile(allMs, 50),
    p95: percentile(allMs, 95),
    min: allMs[0],
    max: allMs.at(-1),
    under4s: asked.filter((r) => r.ok && r.ms <= 4000).length,
    sanitisedToZero: zero,
    sanitisedToZeroRate: asked.length === 0 ? null : zero / asked.length,
    notesAnswered: answered,
    notesKept: kept,
    dropLog: drops,
    runs,
    prompt: buildPhrasePrompt(grid, { bar: 8, budgetLeft: 160, music: musicAt(8) }, notesForBar(grid, 8, 160)),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`openai-latency: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
