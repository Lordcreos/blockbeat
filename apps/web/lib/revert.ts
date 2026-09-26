/**
 * Decoded custom-error name of a viem revert, or null. The shared ABI carries every error
 * of Blockbeat.sol (review H10), so `ContractFunctionRevertedError.data.errorName` is the
 * one place a revert reason comes from: never message text, never a raw selector.
 */
import { BaseError, ContractFunctionRevertedError } from 'viem';

export function revertErrorName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  return revert.data?.errorName ?? null;
}
