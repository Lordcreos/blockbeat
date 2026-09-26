import { afterEach, describe, expect, it, vi } from 'vitest';
import { MONAD_TESTNET_EXPLORER } from '@blockbeat/shared';
import { explorerTokenLink, explorerTxLink } from './explorer';

const TX = `0x${'ab'.repeat(32)}` as const;
const ADDR = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;

describe('explorer links', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('points at Monadscan on testnet', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '');
    expect(explorerTxLink(TX)).toBe(`${MONAD_TESTNET_EXPLORER}/tx/${TX}`);
    expect(explorerTokenLink(ADDR, 3n)).toBe(`${MONAD_TESTNET_EXPLORER}/nft/${ADDR}/3`);
  });

  it('has no explorer on anvil', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337');
    expect(explorerTxLink(TX)).toBeNull();
    expect(explorerTokenLink(ADDR, 3n)).toBeNull();
  });
});
