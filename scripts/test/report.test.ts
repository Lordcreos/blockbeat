import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/lib/stats';
import { renderRunSection, upsertRunsSection, writeReport, type MemoryFs, type RunMeta } from '../src/lib/report';

function memFs(initial: Record<string, string> = {}): MemoryFs & { files: Map<string, string>; dirs: string[] } {
  const files = new Map(Object.entries(initial));
  const dirs: string[] = [];
  return {
    files,
    dirs,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => {
      files.set(p, c);
    },
    mkdir: (p) => {
      dirs.push(p);
    },
  };
}

const meta: RunMeta = {
  startedAt: '2026-09-25T10:00:00.000Z',
  chainId: 31337,
  chainName: 'Anvil (local)',
  rpc: 'http://127.0.0.1:8545',
  ws: 'ws://127.0.0.1:8545',
  address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  sessionId: '1',
  wallets: 2,
  hitsPerWallet: 1,
  windowMs: 1000,
  rps: 50,
  blockMs: 300,
  measuredBlockMs: 310,
  lagBlocks: 1,
};

const summary = aggregate(
  [
    { wallet: 0, index: 0, sentAt: 0, receiptAt: 400, blockNumber: 10n, intendedStep: 2, actualStep: 2, latencyMs: 400, status: 'confirmed', gasUsed: 60_000n, effectiveGasPrice: 1n },
    { wallet: 1, index: 1, sentAt: 0, intendedStep: 2, status: 'send-failed', errorCode: 'HTTP_429', rateLimited: true, errorMessage: 'slow down' },
  ],
  { fundedWei: 2n * 10n ** 16n, funderSpentWei: 2n * 10n ** 16n, burnerSpentWei: 60_000n, durationMs: 1000, bucketWaits: 0, bucketWaitedMs: 0 },
);

describe('renderRunSection', () => {
  const md = renderRunSection(meta, summary);

  it('starts with a level-3 heading that carries the timestamp and chain', () => {
    expect(md.startsWith('### 2026-09-25T10:00:00.000Z · Anvil (local) (31337)')).toBe(true);
  });

  it('includes the headline numbers', () => {
    expect(md).toContain('p50 400 ms');
    expect(md).toContain('p95 400 ms');
    expect(md).toContain('p99 400 ms');
    expect(md).toContain('| HTTP_429 | 1 | yes | slow down |');
    expect(md).toContain('on time 1/1');
    expect(md).toContain('Rate-limit hits: 1');
  });

  it('never contains anything that looks like a private key', () => {
    expect(md).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});

describe('upsertRunsSection', () => {
  const run = '### run-A\n\nbody A\n';

  it('creates the document with the header when the file does not exist', () => {
    const out = upsertRunsSection(null, run, '# Load test\n\nintro\n');
    expect(out).toContain('# Load test');
    expect(out).toContain('<!-- loadtest:runs:start -->');
    expect(out).toContain('body A');
    expect(out).toContain('<!-- loadtest:runs:end -->');
  });

  it('prepends the new run inside the markers and keeps the hand-written text outside', () => {
    const existing = '# Load test\n\nhand-written\n\n<!-- loadtest:runs:start -->\n### run-B\n\nbody B\n<!-- loadtest:runs:end -->\n\ntrailer\n';
    const out = upsertRunsSection(existing, run, '# ignored header\n');
    expect(out.indexOf('hand-written')).toBeLessThan(out.indexOf('run-A'));
    expect(out.indexOf('run-A')).toBeLessThan(out.indexOf('run-B'));
    expect(out).toContain('trailer');
    expect(out).not.toContain('ignored header');
  });

  it('appends markers when the file exists without them', () => {
    const out = upsertRunsSection('# something\n', run, '# header\n');
    expect(out.startsWith('# something')).toBe(true);
    expect(out).toContain('run-A');
    expect(out).not.toContain('# header');
  });
});

describe('writeReport', () => {
  it('writes the JSON snapshot and updates the markdown', () => {
    const fs = memFs();
    const out = writeReport({ meta, summary, evidenceDir: 'docs/evidence/loadtest', markdownPath: 'docs/evidence/loadtest.md', fs });
    expect(out.jsonPath).toBe('docs/evidence/loadtest/2026-09-25T10-00-00-000Z.json');
    expect(fs.dirs).toContain('docs/evidence/loadtest');
    const json = JSON.parse(fs.files.get(out.jsonPath) ?? '{}') as { meta: RunMeta; summary: { hits: { total: number } } };
    expect(json.meta.chainId).toBe(31337);
    expect(json.summary.hits.total).toBe(2);
    expect(fs.files.get('docs/evidence/loadtest.md')).toContain('### 2026-09-25T10:00:00.000Z');
  });

  it('runs the scrubber over both outputs', () => {
    const fs = memFs();
    writeReport({ meta: { ...meta, rpc: 'https://p/v2/SECRETKEY' }, summary, evidenceDir: 'd', markdownPath: 'd.md', fs, scrub: (t) => t.replace(/SECRETKEY/g, '[x]') });
    expect(fs.files.get('d.md')).not.toContain('SECRETKEY');
    expect([...fs.files.values()].join('')).not.toContain('SECRETKEY');
  });

  it('serialises without throwing on bigint fields', () => {
    const fs = memFs();
    expect(() => writeReport({ meta, summary, evidenceDir: 'd', markdownPath: 'd.md', fs })).not.toThrow();
  });
});
