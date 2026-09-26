import { afterEach, describe, expect, it } from 'vitest';
import { parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, RESERVE_WINDOW_BLOCKS, livePattern } from '@blockbeat/shared';
import { CrowdAbortError, assertPlayable, runCrowd, sweepPending, type CrowdOptions } from '../../src/lib/crowd/engine';
import { createKeystore, type Keystore, type KeystoreFs } from '../../src/lib/crowd/keystore';
import { FakeCrowdChain } from './fakeChain';

const BLOCK_MS = 20;
const funderKey = generatePrivateKey();
const funder = privateKeyToAccount(funderKey).address;

function memoryKeystore(): { store: Keystore; fs: KeystoreFs & { files: Map<string, string> }; order: string[] } {
  const files = new Map<string, string>();
  const order: string[] = [];
  const fs = {
    files,
    mkdir: () => undefined,
    writeFile: (p: string, text: string) => {
      order.push(`write ${p}`);
      files.set(p, text);
    },
    readFile: (p: string) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    list: (dir: string) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    rename: (from: string, to: string) => {
      const t = files.get(from);
      if (t === undefined) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, t);
    },
  };
  return { store: createKeystore('/k', fs), fs, order };
}

let chain: FakeCrowdChain | null = null;
afterEach(() => chain?.stop());

function setup(funderWei = parseEther('8.9')): { chain: FakeCrowdChain; ks: ReturnType<typeof memoryKeystore>; lines: string[]; opts: CrowdOptions } {
  chain = new FakeCrowdChain(BLOCK_MS, funder, funderWei);
  chain.start();
  const ks = memoryKeystore();
  const lines: string[] = [];
  const opts: CrowdOptions = {
    chainId: 10143,
    contract: '0x1111111111111111111111111111111111111111',
    sessionId: 7n,
    players: 3,
    minutes: (BLOCK_MS * 16 * 6) / 60_000,
    maxWei: parseEther('1.5'),
    seed: 5,
    blockMs: BLOCK_MS,
    hitTimeoutMs: 2_000,
    funderKey,
    notesPerPlayer: null,
    rps: 1000,
    lifetimeBars: 8,
    maxLivePerTrack: 6,
    keystore: ks.store,
    log: (l) => lines.push(l),
  };
  return { chain, ks, lines, opts };
}

describe('crowd engine (W19)', () => {
  it('refuses a session that is not found or finalized before anything is funded', async () => {
    expect(() => assertPlayable(7n, { startBlock: 0n, finalized: false })).toThrow(/session 7 was not found/);
    expect(() => assertPlayable(7n, { startBlock: 5n, finalized: true })).toThrow(/session 7 is finalized/);
    expect(() => assertPlayable(7n, { startBlock: 5n, finalized: false })).not.toThrow();

    const s = setup();
    s.chain.finalized = true;
    await expect(runCrowd(s.opts, s.chain)).rejects.toThrow(CrowdAbortError);
    s.chain.finalized = false;
    s.chain.startBlock = 0n;
    await expect(runCrowd(s.opts, s.chain)).rejects.toThrow(/not found/);
    expect(s.chain.sent).toEqual([]);
    expect(s.ks.fs.files.size).toBe(0);
  });

  it('prints the projection and aborts over budget or over the funder balance, before funding', async () => {
    const s = setup();
    await expect(runCrowd({ ...s.opts, notesPerPlayer: 28, maxWei: parseEther('0.1') }, s.chain)).rejects.toThrow(/exceeds --max-mon/);
    expect(s.lines.some((l) => l.startsWith('projected:'))).toBe(true);
    const poor = setup(parseEther('0.05'));
    await expect(runCrowd(poor.opts, poor.chain)).rejects.toThrow(/funder holds/);
    expect(s.chain.sent).toEqual([]);
    expect(poor.chain.sent).toEqual([]);
  });

  it('plays a small room end to end: keys saved first, paced funding, aimed hits, status per bar, sweep back', async () => {
    const s = setup();
    const result = await runCrowd(s.opts, s.chain);
    // Keys on disk before the first funding transfer.
    expect(s.ks.order[0]).toMatch(/^write \/k\/crowd-.*\.tmp$/);
    const transfers = s.chain.sent.filter((t) => t.kind === 'transfer' && t.from === funder);
    expect(transfers.length).toBe(result.funded);
    // Funder below 10 MON: one funding transfer per reserve window.
    for (let i = 1; i < transfers.length; i++) expect((transfers[i]?.sentAtBlock ?? 0n) - (transfers[i - 1]?.sentAtBlock ?? 0n)).toBeGreaterThan(BigInt(RESERVE_WINDOW_BLOCKS));
    // Each player's first hit waits for its funding to settle 3 blocks.
    for (const t of transfers) {
      const firstHit = s.chain.sent.find((h) => h.kind === 'hit' && h.from === t.to);
      if (firstHit) expect(firstHit.sentAtBlock - t.sentAtBlock).toBeGreaterThan(BigInt(RESERVE_WINDOW_BLOCKS));
    }
    // Fixed gas tiers: the first hit of a burner 200k, the rest 100k; nonces gapless from 0.
    const byPlayer = new Map<Address, typeof s.chain.sent>();
    for (const h of s.chain.sent.filter((x) => x.kind === 'hit')) byPlayer.set(h.from, [...(byPlayer.get(h.from) ?? []), h]);
    for (const hits of byPlayer.values()) {
      expect(hits.map((h) => h.nonce)).toEqual(hits.map((_, i) => i));
      expect(hits.map((h) => h.gas)).toEqual(hits.map((_, i) => (i === 0 ? HIT_GAS_LIMIT_FIRST : HIT_GAS_LIMIT)));
    }
    expect(result.summary.sent).toBeGreaterThan(0);
    expect(result.summary.confirmed).toBe(result.summary.sent);
    expect(result.summary.onStepRatio).toBeGreaterThanOrEqual(0.6);
    expect(s.chain.calls).not.toContain('estimateGas');
    // One status line per bar.
    const status = s.lines.filter((l) => l.startsWith('crowd | bar '));
    expect(status.length).toBeGreaterThanOrEqual(5);
    expect(status[0]).toMatch(/^crowd \| bar \d+\/\d+ \| players \d+\/3 \| sent \d+ \| confirmed \d+ \| on-step \d+% \| spent \d+\.\d{4} MON$/);
    // Swept: every burner is empty but dust, and marked in the keystore.
    expect(result.sweep.failed).toEqual([]);
    for (const p of result.players) expect(s.chain.balances.get(p) ?? 0n).toBeLessThan(parseEther('0.01'));
    const file = [...s.ks.fs.files.keys()][0] ?? '';
    const saved = JSON.parse(s.ks.fs.files.get(file) ?? '{}') as { players: Array<{ swept: boolean }> };
    expect(saved.players.every((p) => p.swept)).toBe(true);
    expect(result.summary.spentWei).toBeGreaterThan(0n);
    expect(result.summary.spentWei).toBeLessThanOrEqual(parseEther('1.5'));
  }, 20_000);

  it('skips a note whose cell is already alive (voice cap / live layer)', async () => {
    const s = setup();
    // Fill every cell of every track so nothing is playable: all notes are skipped as alive.
    for (let track = 0; track < 8; track++) for (let note = 0; note < 32; note++) s.chain.humanHit(track as 0, note, s.chain.block);
    const pattern = livePattern(s.chain.history, s.chain.block + 1n, 8, {});
    expect(pattern.count).toBeGreaterThan(0);
    const result = await runCrowd({ ...s.opts, maxLivePerTrack: 0, minutes: (BLOCK_MS * 16 * 3) / 60_000 }, s.chain);
    expect(result.summary.skippedAlive).toBeGreaterThan(0);
  }, 20_000);

  it('stops sending as soon as the session is finalized, and still sweeps', async () => {
    const s = setup();
    const run = runCrowd({ ...s.opts, minutes: (BLOCK_MS * 16 * 20) / 60_000 }, s.chain);
    let finalizedAt = 0n;
    const timer = setInterval(() => {
      if (!chain || finalizedAt !== 0n) return;
      if (chain.sent.filter((t) => t.kind === 'hit').length >= 2) {
        finalizedAt = chain.block;
        chain.finalize();
      }
    }, 5);
    const result = await run;
    clearInterval(timer);
    expect(result.stopReason).toBe('finalized');
    expect(s.chain.sent.filter((t) => t.kind === 'hit' && t.sentAtBlock > finalizedAt + 1n)).toEqual([]);
    expect(result.sweep.failed).toEqual([]);
  }, 20_000);

  it('also notices a finalize whose event it missed (a WebSocket drop): it re-reads the session', async () => {
    const s = setup();
    const run = runCrowd({ ...s.opts, minutes: (BLOCK_MS * 16 * 30) / 60_000, sessionCheckMs: 100 }, s.chain);
    setTimeout(() => {
      if (chain) chain.finalized = true; // no Finalized event
    }, BLOCK_MS * 16 * 3);
    const result = await run;
    expect(result.stopReason).toBe('finalized');
    expect(result.durationMs).toBeLessThan(BLOCK_MS * 16 * 20);
  }, 20_000);

  it('stops on the abort signal (SIGINT) and sweeps', async () => {
    const s = setup();
    const ac = new AbortController();
    const run = runCrowd({ ...s.opts, minutes: 1, signal: ac.signal }, s.chain);
    setTimeout(() => ac.abort(), BLOCK_MS * 16 * 3);
    const result = await run;
    expect(result.stopReason).toBe('stopped');
    expect(result.sweep.failed).toEqual([]);
  }, 20_000);

  it('retries a failed sweep, and --sweep-only returns what a failed run left', async () => {
    const s = setup();
    const ks = s.ks;
    const burner = generatePrivateKey();
    const address = privateKeyToAccount(burner).address;
    s.chain.balances.set(address, parseEther('0.2'));
    ks.store.create({ chainId: 10143, contract: s.opts.contract, sessionId: 7n, funder, players: [{ address, privateKey: burner }] });
    // Two failures, then success: retried within one sweep.
    s.chain.failTransfersFrom.set(address, 2);
    const first = await sweepPending({ keystore: ks.store, chain: s.chain, chainId: 10143, blockMs: BLOCK_MS, log: () => undefined });
    expect(first.failed).toEqual([]);
    expect(first.sweptWei).toBeGreaterThan(parseEther('0.19'));
    expect(ks.store.pending()).toEqual([]);

    // Every attempt fails: the player stays pending for the next --sweep-only.
    const other = generatePrivateKey();
    const otherAddress = privateKeyToAccount(other).address;
    s.chain.balances.set(otherAddress, parseEther('0.1'));
    ks.store.create({ chainId: 10143, contract: s.opts.contract, sessionId: 8n, funder, players: [{ address: otherAddress, privateKey: other }] });
    s.chain.failTransfersFrom.set(otherAddress, 99);
    const failed = await sweepPending({ keystore: ks.store, chain: s.chain, chainId: 10143, blockMs: BLOCK_MS, log: () => undefined });
    expect(failed.failed).toEqual([otherAddress]);
    expect(ks.store.pending()).toHaveLength(1);
    s.chain.failTransfersFrom.set(otherAddress, 0);
    const retry = await sweepPending({ keystore: ks.store, chain: s.chain, chainId: 10143, blockMs: BLOCK_MS, log: () => undefined });
    expect(retry.failed).toEqual([]);
    expect(ks.store.pending()).toEqual([]);
    // A run file for another chain is left alone.
    ks.store.create({ chainId: 31337, contract: s.opts.contract, sessionId: 9n, funder, players: [{ address: otherAddress, privateKey: other }] });
    const skipped = await sweepPending({ keystore: ks.store, chain: s.chain, chainId: 10143, blockMs: BLOCK_MS, log: () => undefined });
    expect(skipped.skippedRuns).toBe(1);
  }, 20_000);
});
