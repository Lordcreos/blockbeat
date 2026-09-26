/**
 * W19: the crowd run's evidence, one JSON (every note record) and one Markdown summary per run
 * under docs/evidence/crowd/. Burner keys never enter the result; `scrub` is the last line of
 * defence for anything printed.
 */
import type { CrowdResult } from './engine';
import type { VisibleResult } from './ui/visible';
import { formatMon } from './engine';

export interface CrowdReportMeta {
  chainId: number;
  chainName: string;
  rpc: string;
  address: string;
  sessionId: string;
  players: number;
  minutes: number;
  maxMon: string;
  seed: number;
  note: string | null;
}

export interface ReportFs {
  writeFile(path: string, content: string): void;
  mkdir(path: string): void;
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)} %`);
const ms = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v)} ms`);

export function renderCrowdMarkdown(meta: CrowdReportMeta, r: CrowdResult): string {
  const s = r.summary;
  const delta = r.funderAfterWei - r.funderBeforeWei;
  const rows: Array<[string, string]> = [
    ['Players (planned / funded)', `${meta.players} / ${r.funded}`],
    ['Bars (4.8 s each)', `${s.bars} (${meta.minutes} min), stopped: ${r.stopReason}`],
    ['Notes planned (upper bound)', `${s.planned} (≤ ${r.notesPerPlayer} per player)`],
    ['Notes sent / confirmed', `${s.sent} / ${s.confirmed}`],
    ['On-step (aimed)', `${s.onStep} / ${s.confirmed} = ${pct(s.onStep, s.confirmed)}`],
    ['Latency send → Hit log, p50 / p95', `${ms(s.latencyP50Ms)} / ${ms(s.latencyP95Ms)}`],
    ['Skipped (cell alive)', String(s.skippedAlive)],
    ['Skipped (player not funded yet) / late / cancelled at stop', `${s.skippedNotReady} / ${s.skippedLate} / ${s.cancelled}`],
    ['Reverted / send failed / timed out', `${s.reverted} / ${s.sendFailed} / ${s.timeout}`],
    ['Projected cost (budget)', `${formatMon(r.projectedWei)} MON (--max-mon ${meta.maxMon})`],
    ['Fees spent', `${formatMon(s.spentWei)} MON`],
    ['Funder before → after', `${formatMon(r.funderBeforeWei)} → ${formatMon(r.funderAfterWei)} MON (${delta < 0n ? '−' : '+'}${formatMon(delta < 0n ? -delta : delta)})`],
    ['Sweep', `${formatMon(r.sweep.sweptWei)} MON returned, ${r.sweep.failed.length} burners left${r.sweep.failed.length ? ' (run `pnpm --filter scripts crowd -- --sweep-only`)' : ''}`],
  ];
  return [
    `## Crowd run ${r.startedAt}: session ${meta.sessionId} on ${meta.chainName} (${meta.chainId})`,
    '',
    `Contract \`${meta.address}\`, RPC ${meta.rpc}, seed ${meta.seed}${meta.note ? `, note: ${meta.note}` : ''}. Funder ${r.funder}.`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    'Status lines (one per bar):',
    '',
    '```',
    ...r.statusLines,
    '```',
    '',
  ].join('\n');
}

export function writeCrowdReport(input: { meta: CrowdReportMeta; result: CrowdResult; dir: string; fs: ReportFs; scrub: (text: string) => string }): { jsonPath: string; markdownPath: string } {
  const { meta, result, dir, fs, scrub } = input;
  const stem = `${dir}/crowd-${result.startedAt.replace(/[:.]/g, '-')}-s${meta.sessionId}`;
  const json = JSON.stringify({ meta, ...result }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
  fs.mkdir(dir);
  fs.writeFile(`${stem}.json`, `${scrub(json)}\n`);
  fs.writeFile(`${stem}.md`, scrub(renderCrowdMarkdown(meta, result)));
  return { jsonPath: `${stem}.json`, markdownPath: `${stem}.md` };
}

/** Visible mode (`--ui`): the phones' own clicks, and what the chain saw of them. */
export function renderVisibleMarkdown(meta: CrowdReportMeta, r: VisibleResult): string {
  const rows: Array<[string, string]> = [
    ['Windows opened / funded by the drip / room full', `${r.opened} / ${r.ready} / ${r.roomFull}`],
    ['Duration, stop', `${Math.round(r.durationMs / 1000)} s, ${r.stopReason}`],
    ['Mode', r.playMode === 'tap' ? 'Tap now (the next block decides the step)' : 'Aim'],
    ['Notes played / landed', `${r.aimed} / ${r.landed}`],
    ['On-step (aimed)', r.playMode === 'aim' ? `${r.onStep} / ${r.landed} = ${pct(r.onStep, r.landed)}` : 'n/a (Tap now)'],
    ['Fees of the landed notes (estimate)', `${formatMon(r.spentWeiEstimate)} MON`],
    ['Sweep', `${formatMon(r.sweep.sweptWei)} MON returned, ${r.sweep.failed.length} burners left`],
  ];
  return [
    `## Visible crowd run ${r.startedAt}: session ${meta.sessionId} on ${meta.chainName} (${meta.chainId})`,
    '',
    `Headed phones on the real join page, contract \`${meta.address}\`, seed ${meta.seed}${meta.note ? `, note: ${meta.note}` : ''}.`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '```',
    ...r.statusLines,
    '```',
    '',
  ].join('\n');
}
