import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { renderCrowdMarkdown, renderVisibleMarkdown, writeCrowdReport, type CrowdReportMeta } from '../../src/lib/crowd/report';
import { summarize, type CrowdResult } from '../../src/lib/crowd/engine';

const key = generatePrivateKey();
const meta: CrowdReportMeta = { chainId: 10143, chainName: 'Monad Testnet', rpc: 'https://testnet-rpc.monad.xyz', address: '0x1111111111111111111111111111111111111111', sessionId: '12', players: 10, minutes: 2, maxMon: '1.0', seed: 5, note: 'rehearsal' };

function result(): CrowdResult {
  const records: CrowdResult['records'] = [
    { player: 0, bar: 0, step: 0, track: 0, note: 3, targetBlock: 100n, status: 'confirmed', sentAt: 1, txHash: `0x${'a'.repeat(64)}`, gas: 200_000n, landedBlock: 100n, landedStep: 0, latencyMs: 300 },
    { player: 1, bar: 0, step: 4, track: 1, note: 3, targetBlock: 104n, status: 'confirmed', sentAt: 1, txHash: `0x${'b'.repeat(64)}`, gas: 200_000n, landedBlock: 105n, landedStep: 5, latencyMs: 700 },
    { player: 1, bar: 1, step: 4, track: 1, note: 3, targetBlock: 120n, status: 'skipped-alive' },
  ];
  return {
    startedAt: '2026-09-26T10:00:00.000Z',
    durationMs: 120_000,
    stopReason: 'done',
    funder: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    funderBeforeWei: parseEther('8.9'),
    funderAfterWei: parseEther('8.85'),
    keystoreFile: '/repo/scripts/.crowd/crowd-x-s12.json',
    players: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
    personas: [],
    funded: 2,
    notesPerPlayer: 9,
    projectedWei: parseEther('0.9'),
    records,
    statusLines: ['crowd | bar 1/25 | players 2/10 | sent 2 | confirmed 2 | on-step 50% | spent 0.0450 MON'],
    summary: summarize(records, 3, 25, parseEther('0.05')),
    sweep: { sweptWei: parseEther('0.3'), failed: [], skippedRuns: 0 },
  };
}

describe('crowd report (W19)', () => {
  it('renders the numbers the runbook quotes', () => {
    const md = renderCrowdMarkdown(meta, result());
    expect(md).toContain('session 12');
    expect(md).toMatch(/Notes sent \/ confirmed \| 2 \/ 2/);
    expect(md).toMatch(/On-step \(aimed\) \| 1 \/ 2 = 50\.0 %/);
    expect(md).toMatch(/p50 \/ p95 \| 300 ms \/ 700 ms/);
    expect(md).toMatch(/Skipped \(cell alive\) \| 1/);
    expect(md).toMatch(/Fees spent \| 0\.0500 MON/);
    expect(md).toMatch(/Funder before → after \| 8\.9000 → 8\.8500 MON \(−0\.0500\)/);
    expect(md).toMatch(/Sweep \| 0\.3000 MON returned, 0 burners left/);
  });

  it('writes JSON and Markdown and scrubs every secret it is given', () => {
    const files = new Map<string, string>();
    const r = result();
    r.statusLines.push(`oops ${key}`);
    const out = writeCrowdReport({ meta, result: r, dir: '/repo/docs/evidence/crowd', fs: { writeFile: (p, c) => void files.set(p, c), mkdir: () => undefined }, scrub: (t) => t.split(key).join('[redacted-key]') });
    expect(out.jsonPath).toMatch(/\/repo\/docs\/evidence\/crowd\/crowd-2026-09-26T10-00-00-000Z-s12\.json$/);
    expect(out.markdownPath.endsWith('.md')).toBe(true);
    const json = files.get(out.jsonPath) ?? '';
    expect(json).not.toContain(key);
    expect(json).toContain('[redacted-key]');
    expect(JSON.parse(json).summary.spentWei).toBe(parseEther('0.05').toString());
    expect(files.get(out.markdownPath)).toContain('On-step');
  });

  it('renders a visible-mode run: windows, drips, aimed and landed notes', () => {
    const md = renderVisibleMarkdown(meta, {
      startedAt: '2026-09-26T10:00:00.000Z', durationMs: 60_000, stopReason: 'done', playMode: 'aim', personas: [], opened: 3, ready: 3, roomFull: 0, aimed: 12, landed: 11, onStep: 9,
      spentWeiEstimate: parseEther('0.13'), statusLines: ['crowd | bar 1/13 | players 1/3 | sent 2 | confirmed 1 | on-step 100% | spent 0.0204 MON'], keystoreFile: '/k/x.json', sweep: { sweptWei: parseEther('0.7'), failed: [], skippedRuns: 0 },
    });
    expect(md).toContain('Visible crowd run');
    expect(md).toMatch(/Windows opened \/ funded by the drip \/ room full \| 3 \/ 3 \/ 0/);
    expect(md).toMatch(/Notes played \/ landed \| 12 \/ 11/);
    expect(md).toMatch(/On-step \(aimed\) \| 9 \/ 11 = 81\.8 %/);
    expect(md).toMatch(/Sweep \| 0\.7000 MON returned/);
  });
});
