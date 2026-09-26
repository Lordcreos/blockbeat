import { describe, expect, it, vi } from 'vitest';
import { STEPS, TRACKS, emptyPattern, toggle, type TrackId } from '@blockbeat/shared';
import { barsLeft, buildGrid, createHitLedger, createPatternReader, overlayAgentCells, renderGrid, type Grid } from './pattern';

const AGENT = '0x2222222222222222222222222222222222222222' as const;
const HUMAN = '0x1111111111111111111111111111111111111111' as const;

function patternWith(cells: Array<[step: number, track: TrackId, note: number]>): bigint[] {
  const p = emptyPattern();
  for (const [s, t, n] of cells) p[s] = toggle(p[s] ?? 0n, t, n);
  return p;
}

describe('buildGrid / renderGrid', () => {
  it('renders an empty pattern as 8 rows of 16 dots with a header', () => {
    const grid = buildGrid(emptyPattern(), () => 'human');
    const lines = renderGrid(grid).split('\n');
    expect(lines).toHaveLength(TRACKS + 1);
    expect(lines[0]).toContain('0123456789012345');
    for (const line of lines.slice(1)) expect(line).toMatch(/^[a-z]{2,5}\s+\.{16}$/);
    expect(grid.cells).toEqual([]);
    expect(grid.isEmpty).toBe(true);
  });

  it('marks human hits with H and agent hits with A', () => {
    const p = patternWith([
      [0, 0, 0],
      [2, 2, 5],
      [4, 0, 0],
    ]);
    const grid = buildGrid(p, (step, track) => (track === 2 && step === 2 ? 'agent' : 'human'));
    const text = renderGrid(grid);
    expect(text).toContain('kick  H...H...........');
    expect(text).toContain('hat   ..A.............');
    expect(grid.cells).toEqual([
      { step: 0, track: 0, note: 0, owner: 'human' },
      { step: 2, track: 2, note: 5, owner: 'agent' },
      { step: 4, track: 0, note: 0, owner: 'human' },
    ]);
    expect(grid.isEmpty).toBe(false);
  });

  it('prefers H when a human and the agent share a step on the same track', () => {
    const p = patternWith([
      [3, 1, 0],
      [3, 1, 1],
    ]);
    const grid = buildGrid(p, (_s, _t, note) => (note === 1 ? 'agent' : 'human'));
    expect(renderGrid(grid)).toContain('snare ...H............');
  });

  it('reports whether a track has a note on a step', () => {
    const grid = buildGrid(patternWith([[7, 4, 12]]), () => 'human');
    expect(grid.isOn(7, 4)).toBe(true);
    expect(grid.isOn(7, 4, 12)).toBe(true);
    expect(grid.isOn(7, 4, 11)).toBe(false);
    expect(grid.isOn(6, 4)).toBe(false);
  });
});

describe('overlayAgentCells', () => {
  it('marks pending agent hits as on so the brain never plans them twice', () => {
    const base = buildGrid(patternWith([[0, 0, 0]]), () => 'human');
    const grid = overlayAgentCells(base, [
      { step: 13, track: 2, note: 0 },
      { step: 0, track: 0, note: 0 }, // already on: stays human, not duplicated
    ]);
    expect(grid.isOn(13, 2)).toBe(true);
    expect(grid.isOn(13, 2, 0)).toBe(true);
    expect(grid.cells).toEqual([
      { step: 0, track: 0, note: 0, owner: 'human' },
      { step: 13, track: 2, note: 0, owner: 'agent' },
    ]);
    expect(renderGrid(grid)).toContain('hat   .............A..');
    expect(base.isOn(13, 2)).toBe(false);
  });
});

describe('hit ledger', () => {
  it('attributes a cell to whoever toggled it on last', () => {
    const ledger = createHitLedger(AGENT);
    ledger.apply({ step: 0, track: 0, note: 0, player: HUMAN, on: true });
    expect(ledger.ownerOf(0, 0, 0)).toBe('human');
    ledger.apply({ step: 0, track: 0, note: 0, player: AGENT, on: false });
    ledger.apply({ step: 0, track: 0, note: 0, player: AGENT, on: true });
    expect(ledger.ownerOf(0, 0, 0)).toBe('agent');
  });

  it('compares addresses case-insensitively and defaults unknown cells to human', () => {
    const ledger = createHitLedger(AGENT.toLowerCase() as typeof AGENT);
    ledger.apply({ step: 1, track: 1, note: 1, player: AGENT, on: true });
    expect(ledger.ownerOf(1, 1, 1)).toBe('agent');
    expect(ledger.ownerOf(9, 9 as TrackId, 9)).toBe('human');
  });
});

describe('pattern reader', () => {
  function fakeChain(words: bigint[], logs: Array<{ blockNumber: bigint; logIndex?: number; args: Record<string, unknown> }>) {
    const readContract = vi.fn(async () => words);
    const getLogs = vi.fn(async (args: { fromBlock: bigint; toBlock: bigint }) =>
      logs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock).map((l) => ({ logIndex: 0, ...l })),
    );
    return { readContract, getLogs };
  }

  it('reads pattern() and attributes cells from Hit logs since the session start', async () => {
    const words = patternWith([
      [0, 0, 0],
      [2, 2, 0],
    ]);
    const chain = fakeChain(words, [
      { blockNumber: 100n, args: { sessionId: 1n, player: HUMAN, blockNumber: 100n, step: 0, track: 0, note: 0, on: true } },
      { blockNumber: 102n, args: { sessionId: 1n, player: AGENT, blockNumber: 102n, step: 2, track: 2, note: 0, on: true } },
    ]);
    const reader = createPatternReader({
      client: chain,
      address: '0x2222222222222222222222222222222222222222',
      sessionId: 1n,
      agentAddress: AGENT,
      startBlock: 100n,
      chunkSize: 100,
    });
    const grid: Grid = await reader.read(115n);
    expect(grid.cells).toEqual([
      { step: 0, track: 0, note: 0, owner: 'human' },
      { step: 2, track: 2, note: 0, owner: 'agent' },
    ]);
    expect(chain.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'pattern', args: [1n], blockNumber: 115n }),
    );
  });

  it('scans logs incrementally in chunks and never re-reads a block', async () => {
    const chain = fakeChain(emptyPattern(), []);
    const reader = createPatternReader({
      client: chain,
      address: '0x2222222222222222222222222222222222222222',
      sessionId: 1n,
      agentAddress: AGENT,
      startBlock: 100n,
      chunkSize: 10,
    });
    await reader.read(125n);
    const ranges = chain.getLogs.mock.calls.map(([a]) => [a.fromBlock, a.toBlock]);
    expect(ranges).toEqual([
      [100n, 109n],
      [110n, 119n],
      [120n, 125n],
    ]);
    chain.getLogs.mockClear();
    await reader.read(130n);
    expect(chain.getLogs.mock.calls.map(([a]) => [a.fromBlock, a.toBlock])).toEqual([[126n, 130n]]);
  });

  it('rejects malformed logs instead of silently ignoring them', async () => {
    const chain = fakeChain(emptyPattern(), [
      { blockNumber: 100n, args: { sessionId: 1n, player: HUMAN, blockNumber: 100n, step: 99, track: 0, note: 0, on: true } },
    ]);
    const reader = createPatternReader({
      client: chain,
      address: '0x2222222222222222222222222222222222222222',
      sessionId: 1n,
      agentAddress: AGENT,
      startBlock: 100n,
    });
    await expect(reader.read(100n)).rejects.toThrow(/step/);
  });

  it('W13: rejects a Hit log without a logIndex (it could not be ordered for the live layer)', async () => {
    const chain = {
      readContract: vi.fn(async () => emptyPattern()),
      getLogs: vi.fn(async () => [{ blockNumber: 100n, logIndex: null, args: { sessionId: 1n, player: HUMAN, blockNumber: 100n, step: 0, track: 0, note: 0, on: true } }]),
    };
    const reader = createPatternReader({ client: chain, address: '0x2222222222222222222222222222222222222222', sessionId: 1n, agentAddress: AGENT, startBlock: 100n });
    await expect(reader.read(100n)).rejects.toThrow(/logIndex/);
  });

  it('exposes the step geometry it renders', () => {
    expect(STEPS).toBe(16);
  });
});

describe('live grid (W13)', () => {
  const decay = { lifetimeBars: 8, maxLivePerTrack: 6 };
  const log = (blockNumber: bigint, step: number, track: number, note: number, player: string, on = true, logIndex = 0) => ({
    blockNumber,
    logIndex,
    args: { sessionId: 1n, player, blockNumber, step, track, note, on },
  });

  function reader(words: bigint[], logs: ReturnType<typeof log>[]) {
    const chain = {
      readContract: vi.fn(async () => words),
      getLogs: vi.fn(async (args: { fromBlock: bigint; toBlock: bigint }) => logs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock)),
    };
    return createPatternReader({ client: chain, address: '0x2222222222222222222222222222222222222222', sessionId: 1n, agentAddress: AGENT, startBlock: 100n, decay });
  }

  it('plans on the live layer at the block the next bar starts: expired notes are gone, refreshed ones stay', async () => {
    const r = reader(patternWith([[4, 0, 0]]), [
      log(100n, 0, 0, 0, HUMAN), // expires at 228
      log(120n, 4, 0, 0, HUMAN),
      log(130n, 4, 0, 0, AGENT, false), // refresh by the agent: alive, owned by the agent now
    ]);
    const grid = await r.read(215n, 231n);
    expect(grid.decay).toBe(true);
    expect(grid.cells).toEqual([{ step: 4, track: 0, note: 0, owner: 'agent', remainingBlocks: 27 }]);
    expect(grid.isOn(0, 0, 0)).toBe(false);
    expect(grid.isOn(4, 0, 0)).toBe(true);
  });

  it('knows which recorded bits a human set, so the DJ never clears one in the NFT', async () => {
    const words = patternWith([
      [0, 0, 0],
      [8, 0, 0],
    ]);
    const logs = [log(100n, 0, 0, 0, HUMAN), log(108n, 8, 0, 0, AGENT)];
    const grid = await reader(words, logs).read(380n, 396n); // both expired, both inside the scanned window
    expect(grid.cells).toEqual([]);
    expect(grid.recordedHuman(0, 0, 0)).toBe(true);
    expect(grid.recordedHuman(8, 0, 0)).toBe(false);
    expect(grid.recordedHuman(0, 0, 1)).toBe(false);
    // Older than the bounded first scan: the owner is unknown and reads as human (the safe side).
    const late = await reader(words, logs).read(5_000n, 5_016n);
    expect(late.recordedHuman(8, 0, 0)).toBe(true);
  });

  it('applies the voice cap like the stage', async () => {
    const logs = Array.from({ length: 8 }, (_, i) => log(200n + BigInt(i), i, 2, 0, HUMAN));
    const grid = await reader(emptyPattern(), logs).read(210n, 210n);
    expect(grid.cells.map((c) => c.step)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(grid.maxLivePerTrack).toBe(6);
  });

  it('keeps pending agent hits and the W13 fields through the overlay', async () => {
    const grid = await reader(emptyPattern(), []).read(300n, 316n);
    const merged = overlayAgentCells(grid, [{ step: 0, track: 0, note: 0 }]);
    expect(merged.decay).toBe(true);
    expect(merged.isOn(0, 0, 0)).toBe(true);
    expect(merged.recordedHuman(0, 0, 0)).toBe(false);
  });

  it('bounds the first scan to the replay window on an old session (coordinator: 63 s catch-up on testnet)', async () => {
    const chain = {
      readContract: vi.fn(async () => emptyPattern()),
      getLogs: vi.fn(async (_args: { fromBlock: bigint; toBlock: bigint }) => []),
    };
    const r = createPatternReader({ client: chain, address: '0x2222222222222222222222222222222222222222', sessionId: 1n, agentAddress: AGENT, startBlock: 100n, decay });
    await r.read(20_100n, 20_116n);
    const ranges = chain.getLogs.mock.calls.map(([a]) => [a.fromBlock, a.toBlock]);
    // 2 lifetimes (256) + fade (32) + margin (16) = 304 blocks below the head, never the session start.
    expect(ranges[0]?.[0]).toBe(20_100n - 304n);
    expect(ranges.at(-1)?.[1]).toBe(20_100n);
    expect(ranges).toHaveLength(4);
    chain.getLogs.mockClear();
    await r.read(20_116n, 20_132n);
    expect(chain.getLogs.mock.calls.map(([a]) => [a.fromBlock, a.toBlock])).toEqual([[20_101n, 20_116n]]);
  });

  it('with decay off reads the recorded pattern as before', async () => {
    const chain = {
      readContract: vi.fn(async () => patternWith([[1, 1, 1]])),
      getLogs: vi.fn(async () => []),
    };
    const r = createPatternReader({ client: chain, address: '0x2222222222222222222222222222222222222222', sessionId: 1n, agentAddress: AGENT, startBlock: 100n, decay: { lifetimeBars: 0, maxLivePerTrack: 6 } });
    const grid = await r.read(9_000n, 9_016n);
    expect(grid.decay).toBe(false);
    expect(grid.cells).toEqual([{ step: 1, track: 1, note: 1, owner: 'human' }]);
  });

  it('renders the bars a live note has left for the LLM', async () => {
    const grid = await reader(emptyPattern(), [log(300n, 2, 2, 0, HUMAN)]).read(316n, 316n);
    expect(barsLeft(grid.cells[0])).toBe(7);
  });
});

describe('overlayAgentCells de-duplication (W14b review)', () => {
  it('adds a cell once even when it is both pending and landed', () => {
    const g = buildGrid(emptyPattern(), () => 'human');
    const out = overlayAgentCells(g, [
      { step: 3, track: 3, note: 0 },
      { step: 3, track: 3, note: 0 },
      { step: 4, track: 3, note: 0 },
    ]);
    expect(out.cells).toHaveLength(2);
  });
});
