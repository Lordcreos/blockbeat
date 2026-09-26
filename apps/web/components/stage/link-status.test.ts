import { describe, expect, it } from 'vitest';
import { linkStatus } from './link-status';

describe('linkStatus', () => {
  it('is live while heads keep arriving', () => {
    expect(linkStatus({ source: 'ws', connected: true, msSinceHead: 300, error: null, chainName: 'Monad Testnet' })).toEqual({
      level: 'ok',
      label: 'Live on Monad Testnet',
    });
    expect(linkStatus({ source: 'poll', connected: true, msSinceHead: 900, error: null, chainName: 'Monad Testnet' }).label).toBe('Polling Monad Testnet');
    expect(linkStatus({ source: 'mock', connected: true, msSinceHead: 0, error: null, chainName: 'x' }).label).toBe('Mock clock, no chain');
  });
  it('goes stale after 1.5 s without a head and says for how long', () => {
    expect(linkStatus({ source: 'ws', connected: true, msSinceHead: 4200, error: null, chainName: 'Monad Testnet' })).toEqual({
      level: 'stale',
      label: 'No block for 4 s',
    });
  });
  it('reports a feed error above everything else', () => {
    expect(linkStatus({ source: 'ws', connected: false, msSinceHead: 100, error: 'could not read pattern', chainName: 'Monad Testnet' })).toEqual({
      level: 'error',
      label: 'Feed error: could not read pattern',
    });
  });
  it('is an error when the feed is disconnected', () => {
    expect(linkStatus({ source: 'ws', connected: false, msSinceHead: 100, error: null, chainName: 'Monad Testnet' }).level).toBe('error');
  });
});
