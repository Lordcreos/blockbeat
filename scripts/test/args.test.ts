import { describe, expect, it } from 'vitest';
import { ANVIL_ID, MONAD_TESTNET_ID, MONAD_TESTNET_RPC_HTTP, MONAD_TESTNET_RPC_WS, PUBLIC_RPC_RPS, ZERO_ADDRESS, blockbeatAddress } from '@blockbeat/shared';
import * as argsModule from '../src/lib/args';
import { parseFlags, parseLoadtestArgs } from '../src/lib/args';

describe('parseFlags', () => {
  it('parses --key value and --key=value', () => {
    expect(parseFlags(['--a', '1', '--b=2', '--flag'])).toEqual({ a: '1', b: '2', flag: 'true' });
  });

  it('rejects positional arguments', () => {
    expect(() => parseFlags(['stray'])).toThrow(/stray/);
  });

  it('ignores a bare -- separator (pnpm 9 forwards it: `pnpm --filter scripts fund-drip -- --players 20`)', () => {
    expect(parseFlags(['--', '--players', '20'])).toEqual({ players: '20' });
    expect(parseFlags(['--start', '--'])).toEqual({ start: 'true' });
  });
});

describe('parseLoadtestArgs', () => {
  it('applies the testnet defaults', () => {
    const o = parseLoadtestArgs([], {});
    expect(o.chainId).toBe(MONAD_TESTNET_ID);
    expect(o.rpc).toBe(MONAD_TESTNET_RPC_HTTP);
    expect(o.ws).toBe(MONAD_TESTNET_RPC_WS);
    expect(o.wallets).toBe(40);
    expect(o.hits).toBe(30);
    expect(o.windowMs).toBe(60_000);
    expect(o.rps).toBe(PUBLIC_RPC_RPS);
    expect(o.sessionId).toBe(1n);
    expect(o.address).toBe(blockbeatAddress(MONAD_TESTNET_ID));
    expect(o.sweep).toBe(false);
  });

  it('switches rpc/ws defaults with the chain id', () => {
    const o = parseLoadtestArgs(['--chain-id', String(ANVIL_ID)], {});
    expect(o.rpc).toBe('http://127.0.0.1:8545');
    expect(o.ws).toBe('ws://127.0.0.1:8545');
    expect(o.lagBlocks).toBe(0);
  });

  it('honours explicit flags and env fallbacks', () => {
    const o = parseLoadtestArgs(
      ['--rpc', 'http://r', '--ws', 'ws://w', '--address', '0x5FbDB2315678afecb367f032d93F642f64180aa3', '--session', '7', '--wallets', '3', '--hits', '2', '--window-ms', '500', '--rps', '10', '--sweep'],
      { MONAD_RPC_URL: 'http://env' },
    );
    expect(o.rpc).toBe('http://r');
    expect(o.ws).toBe('ws://w');
    expect(o.address).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
    expect(o.sessionId).toBe(7n);
    expect(o.wallets).toBe(3);
    expect(o.hits).toBe(2);
    expect(o.windowMs).toBe(500);
    expect(o.rps).toBe(10);
    expect(o.sweep).toBe(true);
    expect(parseLoadtestArgs([], { MONAD_RPC_URL: 'http://env', BLOCKBEAT_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }).rpc).toBe('http://env');
  });

  it('refuses an rps above the public limit unless overridden', () => {
    expect(() => parseLoadtestArgs(['--rps', '500'], {})).toThrow(/rps/);
    expect(parseLoadtestArgs(['--rps', '500', '--allow-over-limit'], {}).rps).toBe(500);
  });

  it('rejects non-numeric and out-of-range values', () => {
    expect(() => parseLoadtestArgs(['--wallets', 'x'], {})).toThrow(/wallets/);
    expect(() => parseLoadtestArgs(['--hits', '0'], {})).toThrow(/hits/);
    expect(() => parseLoadtestArgs(['--address', 'nope'], {})).toThrow(/address/);
    expect(() => parseLoadtestArgs(['--unknown', '1'], {})).toThrow(/unknown/);
  });
});

describe('parseFundDripArgs', () => {
  it('defaults to 60 players and the shared drip amount, env overrides the amount', () => {
    const { parseFundDripArgs } = argsModule;
    const o = parseFundDripArgs([], {}, '0.05');
    expect(o.players).toBe(60);
    expect(o.dripAmountMon).toBe('0.05');
    expect(parseFundDripArgs(['--players', '10', '--drip-mon', '0.5'], { DRIP_AMOUNT_MON: '0.2' }, '0.05')).toMatchObject({ players: 10, dripAmountMon: '0.5' });
    expect(parseFundDripArgs([], { DRIP_AMOUNT_MON: '0.2' }, '0.05').dripAmountMon).toBe('0.2');
  });

  it('rejects loadtest-only flags', () => {
    expect(() => argsModule.parseFundDripArgs(['--wallets', '3'], {}, '0.05')).toThrow(/unknown flag/);
  });
});

describe('parseSessionArgs', () => {
  const { parseSessionArgs } = argsModule;

  it('parses --start, --finalize <id> and --status <id>', () => {
    expect(parseSessionArgs(['--start'], {})).toMatchObject({ start: true, finalize: null, status: null });
    expect(parseSessionArgs(['--finalize', '3'], {})).toMatchObject({ start: false, finalize: 3n, status: null });
    expect(parseSessionArgs(['--status', '2', '--start'], {})).toMatchObject({ start: true, finalize: null, status: 2n });
  });

  it('requires an id for --finalize and --status and at least one action', () => {
    expect(() => parseSessionArgs(['--finalize'], {})).toThrow(/session id/);
    expect(() => parseSessionArgs(['--status'], {})).toThrow(/session id/);
    expect(() => parseSessionArgs([], {})).toThrow(/nothing to do/);
    expect(() => parseSessionArgs(['--finalize', '0'], {})).toThrow(/finalize/);
  });
});

describe('sanitizeNote', () => {
  it('strips control and zero-width characters, collapses whitespace and caps the length', () => {
    expect(argsModule.sanitizeNote('a\u0000b\u200b  c\n d')).toBe('ab c d');
    expect(argsModule.sanitizeNote('x'.repeat(500))).toHaveLength(200);
    expect(parseLoadtestArgs(['--note', ' hi\tthere '], {}).note).toBe('hi there');
  });
});
