import { describe, expect, it } from 'vitest';
import { ANVIL_ID, MONAD_TESTNET_ID } from '@blockbeat/shared';
import { ANVIL_ACCOUNTS, parseKeysEnv, redactSecrets, redactUrl, resolveKey, urlSecrets } from '../src/lib/env';

const KEY = '0x' + 'ab'.repeat(32);

describe('parseKeysEnv', () => {
  it('parses KEY=value lines, ignores comments and blanks, strips quotes', () => {
    const out = parseKeysEnv(`# comment\n\nDRIP_PRIVATE_KEY="${KEY}"\nDRIP_ADDRESS=0x1\nexport AGENT_ADDRESS='0x2'\n`);
    expect(out).toEqual({ DRIP_PRIVATE_KEY: KEY, DRIP_ADDRESS: '0x1', AGENT_ADDRESS: '0x2' });
  });

  it('returns an empty record for empty input', () => {
    expect(parseKeysEnv('')).toEqual({});
  });
});

describe('resolveKey', () => {
  it('prefers FUNDER_PRIVATE_KEY, then the role key', () => {
    expect(resolveKey({ chainId: MONAD_TESTNET_ID, env: { FUNDER_PRIVATE_KEY: KEY, DRIP_PRIVATE_KEY: '0x' + '11'.repeat(32) }, role: 'drip' })).toEqual({ key: KEY, source: 'FUNDER_PRIVATE_KEY' });
    expect(resolveKey({ chainId: MONAD_TESTNET_ID, env: { DRIP_PRIVATE_KEY: KEY }, role: 'drip' })).toEqual({ key: KEY, source: 'DRIP_PRIVATE_KEY' });
  });

  it('falls back to the well-known anvil accounts on chain 31337 only', () => {
    expect(resolveKey({ chainId: ANVIL_ID, env: {}, role: 'deployer' })).toEqual({ key: ANVIL_ACCOUNTS[0].key, source: 'anvil:0' });
    expect(resolveKey({ chainId: ANVIL_ID, env: {}, role: 'drip' })).toEqual({ key: ANVIL_ACCOUNTS[1].key, source: 'anvil:1' });
    expect(resolveKey({ chainId: ANVIL_ID, env: {}, role: 'agent' })).toEqual({ key: ANVIL_ACCOUNTS[2].key, source: 'anvil:2' });
    expect(() => resolveKey({ chainId: MONAD_TESTNET_ID, env: {}, role: 'drip' })).toThrow(/DRIP_PRIVATE_KEY/);
  });

  it('ignores testnet role keys on anvil but still honours FUNDER_PRIVATE_KEY', () => {
    expect(resolveKey({ chainId: ANVIL_ID, env: { DEPLOYER_PRIVATE_KEY: KEY }, role: 'deployer' })).toEqual({ key: ANVIL_ACCOUNTS[0].key, source: 'anvil:0' });
    expect(resolveKey({ chainId: ANVIL_ID, env: { FUNDER_PRIVATE_KEY: KEY }, role: 'deployer' })).toEqual({ key: KEY, source: 'FUNDER_PRIVATE_KEY' });
  });

  it('rejects malformed keys', () => {
    expect(() => resolveKey({ chainId: MONAD_TESTNET_ID, env: { DRIP_PRIVATE_KEY: 'abc' }, role: 'drip' })).toThrow(/32-byte/);
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence of a registered secret, case-insensitively', () => {
    expect(redactSecrets(`key ${KEY} and ${KEY.toUpperCase()} here`, [KEY])).toBe('key [redacted-key] and [redacted-key] here');
  });

  it('leaves addresses and transaction hashes alone (same shape as a key, but not registered)', () => {
    const addr = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    const hash = '0x' + 'cd'.repeat(32);
    expect(redactSecrets(`${addr} ${hash}`, [KEY])).toBe(`${addr} ${hash}`);
  });
});

describe('urlSecrets and redactUrl', () => {
  it('finds provider keys in the path, query and userinfo', () => {
    expect(urlSecrets('https://monad-testnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz012345')).toEqual(['AbCdEfGhIjKlMnOpQrStUvWxYz012345']);
    expect(urlSecrets('https://x.quiknode.pro/?token=secrettoken123')).toEqual(['secrettoken123']);
    expect(urlSecrets('wss://user:hunter22@rpc.example/ws')).toEqual(['hunter22']);
  });

  it('leaves public URLs untouched', () => {
    expect(urlSecrets('https://testnet-rpc.monad.xyz')).toEqual([]);
    expect(urlSecrets('http://127.0.0.1:8546')).toEqual([]);
    expect(urlSecrets('not a url')).toEqual([]);
    expect(redactUrl('https://testnet-rpc.monad.xyz')).toBe('https://testnet-rpc.monad.xyz');
  });

  it('redacts the key from the URL', () => {
    expect(redactUrl('https://monad-testnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz012345')).toBe('https://monad-testnet.g.alchemy.com/v2/[redacted-key]');
  });
});
