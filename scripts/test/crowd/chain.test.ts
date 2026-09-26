import { describe, expect, it } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { blockbeatAbi } from '@blockbeat/shared';
import { isSessionNotFound } from '../../src/lib/crowd/chain';

function reverted(errorName: 'SessionNotFound' | 'SessionFinalized'): ContractFunctionExecutionError {
  const cause = new ContractFunctionRevertedError({ abi: blockbeatAbi, data: encodeErrorResult({ abi: blockbeatAbi, errorName }), functionName: 'getSession' });
  return new ContractFunctionExecutionError(cause, { abi: blockbeatAbi, functionName: 'getSession', args: [9n], contractAddress: '0x1111111111111111111111111111111111111111' });
}

describe('crowd chain adapter (W19)', () => {
  it('reads the SessionNotFound revert of getSession as "not found" (seen on testnet), and nothing else', () => {
    expect(isSessionNotFound(reverted('SessionNotFound'))).toBe(true);
    expect(isSessionNotFound(reverted('SessionFinalized'))).toBe(false);
    expect(isSessionNotFound(new Error('fetch failed'))).toBe(false);
  });
});
