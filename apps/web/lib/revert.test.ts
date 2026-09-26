import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, toFunctionSelector } from 'viem';
import { blockbeatAbi } from '@blockbeat/shared';
import { revertErrorName } from './revert';

function reverted(errorName: 'NoHits' | 'ZeroTip' | 'SessionFinalized'): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: blockbeatAbi, functionName: 'tip', data: encodeErrorResult({ abi: blockbeatAbi, errorName }) });
}

describe('revertErrorName (review H10)', () => {
  it('reads the decoded custom error name from a viem revert', () => {
    expect(revertErrorName(reverted('NoHits'))).toBe('NoHits');
    expect(revertErrorName(reverted('SessionFinalized'))).toBe('SessionFinalized');
  });

  it('walks a wrapped execution error down to the revert', () => {
    const wrapped = new ContractFunctionExecutionError(reverted('ZeroTip'), {
      abi: blockbeatAbi,
      args: [1n],
      contractAddress: '0x00000000000000000000000000000000000000aa',
      functionName: 'tip',
    });
    expect(revertErrorName(wrapped)).toBe('ZeroTip');
  });

  it('returns null for text-only errors, unknown selectors and non-errors', () => {
    expect(revertErrorName(new Error('Error: NoHits()'))).toBeNull();
    expect(revertErrorName(new BaseError('boom'))).toBeNull();
    const unknown = new ContractFunctionRevertedError({ abi: blockbeatAbi, functionName: 'tip', data: toFunctionSelector('Nope()') });
    expect(revertErrorName(unknown)).toBeNull();
    expect(revertErrorName('NoHits')).toBeNull();
  });
});
