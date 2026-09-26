/**
 * Review H10: every custom error of Blockbeat.sol (and the inherited OpenZeppelin ERC721
 * ones) must be in the shared ABI so viem decodes a revert to its name. The expected set is
 * what `forge inspect Blockbeat abi` prints for `type: 'error'` (contracts/, solc 0.8.28).
 */
import { describe, expect, it } from 'vitest';
import { decodeErrorResult, encodeErrorResult, toFunctionSelector } from 'viem';
import { blockbeatAbi, blockbeatAbiExt } from '@blockbeat/shared';

const CONTRACT_ERRORS = [
  'BlockBeforeStart',
  'NoHits',
  'NotHost',
  'NoteOutOfRange',
  'NothingToClaim',
  'SessionFinalized',
  'SessionNotFinalized',
  'SessionNotFound',
  'TrackOutOfRange',
  'TransferFailed',
  'ZeroTip',
] as const;

const ERC721_ERRORS = [
  'ERC721IncorrectOwner',
  'ERC721InsufficientApproval',
  'ERC721InvalidApprover',
  'ERC721InvalidOperator',
  'ERC721InvalidOwner',
  'ERC721InvalidReceiver',
  'ERC721InvalidSender',
  'ERC721NonexistentToken',
] as const;

describe('shared ABI custom errors (review H10)', () => {
  it('lists every error forge inspect reports, exactly once', () => {
    const names = blockbeatAbi.filter((e) => e.type === 'error').map((e) => e.name);
    expect([...names].sort()).toEqual([...CONTRACT_ERRORS, ...ERC721_ERRORS].sort());
  });

  it.each(['SessionFinalized', 'NotHost', 'ZeroTip', 'TrackOutOfRange'] as const)('decodes the %s() selector to its name', (name) => {
    const selector = toFunctionSelector(`${name}()`);
    const decoded = decodeErrorResult({ abi: blockbeatAbi, data: selector });
    expect(decoded.errorName).toBe(name);
  });

  it('round-trips an error with arguments', () => {
    const data = encodeErrorResult({ abi: blockbeatAbi, errorName: 'ERC721NonexistentToken', args: [7n] });
    const decoded = decodeErrorResult({ abi: blockbeatAbi, data });
    expect(decoded.errorName).toBe('ERC721NonexistentToken');
    expect(decoded.args).toEqual([7n]);
  });

  it('keeps the additive views that were already in the extension', () => {
    const views = blockbeatAbiExt.filter((e) => e.type === 'function').map((e) => e.name);
    expect(views).toEqual(['sessionCount', 'tokenSession', 'tokenPattern', 'contributorCount', 'contributorsSlice']);
  });
});
