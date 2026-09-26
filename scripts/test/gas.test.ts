import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FINALIZE_GAS_LIMIT, START_SESSION_GAS_LIMIT } from '@blockbeat/shared';

describe('session ops gas limits (review L10)', () => {
  it('uses the shared 900k finalize limit: Monad charges the limit, so 3M would cost 0.3 MON per fallback finalize', () => {
    expect(FINALIZE_GAS_LIMIT).toBe(900_000n);
    expect(START_SESSION_GAS_LIMIT).toBe(250_000n);
    const source = readFileSync(resolve(__dirname, '../src/session.ts'), 'utf8');
    expect(source).toContain('FINALIZE_GAS_LIMIT');
    expect(source).not.toMatch(/3_000_000/);
  });
});

describe('hot-path gas limits cover the costs measured on Monad testnet (W11, docs/evidence/w11-testnet/04-gas-probe.txt)', () => {
  // eth_estimateGas on 10143, 2026-09-25. Monad reprices cold state access, so these exceed the anvil numbers
  // (first hit 140,091 on anvil): the old 160k first-hit limit ran every fresh burner's first hit out of gas.
  const MEASURED = { firstHitEmptySession: 169_565n, firstHitNewPlayer: 117_115n, laterHit: 77_788n, tip: 52_202n, startSession: 63_819n, finalizeOneContributor: 218_423n };
  const withHeadroom = (gas: bigint): bigint => (gas * 110n) / 100n;

  it('keeps at least 10% headroom over every measured cost', async () => {
    const { HIT_GAS_LIMIT, HIT_GAS_LIMIT_FIRST, TIP_GAS_LIMIT } = await import('@blockbeat/shared');
    expect(HIT_GAS_LIMIT_FIRST).toBeGreaterThanOrEqual(withHeadroom(MEASURED.firstHitEmptySession));
    expect(HIT_GAS_LIMIT).toBeGreaterThanOrEqual(withHeadroom(MEASURED.laterHit));
    expect(TIP_GAS_LIMIT).toBeGreaterThanOrEqual(withHeadroom(MEASURED.tip));
    expect(START_SESSION_GAS_LIMIT).toBeGreaterThanOrEqual(withHeadroom(MEASURED.startSession));
    expect(FINALIZE_GAS_LIMIT).toBeGreaterThanOrEqual(withHeadroom(MEASURED.finalizeOneContributor));
  });
});
