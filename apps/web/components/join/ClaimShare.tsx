'use client';
import type { Address } from 'viem';
import { formatMon } from '@/lib/funding';
import { useTipShare } from '@/lib/tips/claims';

interface ClaimShareProps {
  sessionId: bigint;
  address: Address;
}

/**
 * W21b: after the track is minted, a human player's share of the tips (W21a claimableOf),
 * claimed with the phone's burner. Nothing shows while there is nothing to claim.
 */
export function ClaimShare({ sessionId, address }: ClaimShareProps) {
  const share = useTipShare(sessionId, address, true);
  const { state } = share;
  if (state.kind === 'claimed') {
    return (
      <p data-testid="claim-share" role="status" className="num" style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>
        Claimed {formatMon(state.amountWei)} MON. It is in this phone&apos;s wallet.
      </p>
    );
  }
  if (share.claimableWei === null || share.claimableWei <= 0n) return null;
  return (
    <div data-testid="claim-share" className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-4 py-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--track-hat)' }}>
      <span className="flex flex-col">
        <strong className="num" style={{ fontSize: 'var(--text-md)' }}>
          You earned {formatMon(share.claimableWei)} MON from tips
        </strong>
        {state.kind === 'failed' && (
          <span role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
            The claim did not go through: {state.message}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => void share.claim()}
        disabled={state.kind === 'claiming'}
        className="min-h-[44px] shrink-0 rounded-full px-5 py-2 font-bold disabled:opacity-60"
        style={{ fontSize: 'var(--text-md)', background: 'var(--track-hat)', color: 'var(--ink-on-track)' }}
      >
        {state.kind === 'claiming' ? 'Claiming…' : 'Claim'}
      </button>
    </div>
  );
}
