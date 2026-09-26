/**
 * W14 evidence helper: list the Gemini models the key can use, or time N real DJ calls.
 *
 *   pnpm --filter agent exec tsx scripts/gemini-latency.ts --list
 *   pnpm --filter agent exec tsx scripts/gemini-latency.ts --model gemini-x-flash [--n 10] [--gap-ms 13000]
 *
 * --gap-ms spaces the calls (13 s keeps a free-tier key under its 5 requests/min per model).
 *
 * Uses the production path (createGeminiCompleter + createLlmBrain with the live-grid prompt)
 * on a realistic live grid: 7 decaying room notes (W17: the phrase prompt, peak bars). The key comes from GEMINI_API_KEY / GOOGLE_API_KEY (apps/agent/.env) and is never
 * printed. The timeout here is 15 s so the true latency is measured, not the agent's cutoff.
 */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { createGeminiCompleter } from '../src/lib/brain/gemini';
import { createLlmBrain, buildPhrasePrompt } from '../src/lib/brain/llm';
import { notesForBar } from '../src/lib/music/phrase';
import { percentile, realisticGrid } from './latency-fixture';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) throw new Error('set GEMINI_API_KEY (or GOOGLE_API_KEY) in apps/agent/.env');

  if (process.argv.includes('--list')) {
    const ai = new GoogleGenAI({ apiKey });
    const pager = await ai.models.list({ config: { pageSize: 200 } });
    const rows: Array<{ name: string; displayName: string; actions: string }> = [];
    for await (const m of pager) {
      if (!m.name) continue;
      rows.push({ name: m.name, displayName: m.displayName ?? '', actions: (m.supportedActions ?? []).join(',') });
    }
    process.stdout.write(`${JSON.stringify({ count: rows.length, models: rows }, null, 2)}\n`);
    return;
  }

  const model = arg('--model');
  if (!model) throw new Error('--model <id> or --list');
  const n = Number(arg('--n') ?? '10');
  const gapMs = Number(arg('--gap-ms') ?? '0');
  const grid = realisticGrid();
  const complete = createGeminiCompleter({ apiKey, model, timeoutMs: 15_000 });
  const brain = createLlmBrain({ complete, model, provider: 'gemini' });
  const runs: Array<{ i: number; ms: number; ok: boolean; additions: number; plan?: string; error?: string }> = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    const t0 = performance.now();
    try {
      const out = await brain.plan(grid, { bar: 8 + (i % 4), budgetLeft: 160 });
      runs.push({ i, ms: Math.round(performance.now() - t0), ok: true, additions: out.length, plan: out.map((a) => `t${a.track}@${a.step}n${a.note}`).join(' ') });
    } catch (error) {
      // Recorded, not swallowed: a failed call is a data point (and would be a rules bar live).
      runs.push({ i, ms: Math.round(performance.now() - t0), ok: false, additions: 0, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
    }
  }
  const okMs = runs.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const allMs = runs.map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    model,
    n,
    gapMs,
    ok: okMs.length,
    liveNotes: grid.cells.length,
    wanted: notesForBar(grid, 8, 160),
    p50: percentile(allMs, 50),
    p95: percentile(allMs, 95),
    min: allMs[0],
    max: allMs.at(-1),
    okP50: percentile(okMs, 50),
    okP95: percentile(okMs, 95),
    runs,
    prompt: buildPhrasePrompt(grid, { bar: 8, budgetLeft: 160 }, notesForBar(grid, 8, 160)),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`gemini-latency: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
