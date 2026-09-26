'use client';
import { useMemo } from 'react';
import { useMockTrack } from '@/lib/tips/claims';
import { useTipNotes } from '@/lib/tips/hooks';
import { mergeTips } from '@/lib/tips/tipList';
import { TrackTips } from './TrackTips';

/**
 * W21b: the split on /track in mock mode. There is no chain to read on the server, so this
 * island reads the simulator of the tab (the stage navigates here after minting) and the notes
 * the server holds for the session.
 */
export function MockTrackTips({ tokenId }: { tokenId: bigint }) {
  const track = useMockTrack(tokenId);
  const notes = useTipNotes(track?.sessionId ?? null, 3_000, 500);
  const lines = useMemo(() => (track ? mergeTips(track.summary.tips, notes.notes) : []), [track, notes.notes]);
  if (!track) {
    return (
      <p data-testid="mock-track-tips-empty" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)', textWrap: 'pretty' }}>
        On the simulator the tip split lives in the stage tab: open this page from the stage after End session and mint to see who earned what.
      </p>
    );
  }
  return (
    <TrackTips
      hostWei={track.summary.hostWei}
      hostClaimableWei={track.hostClaimableWei}
      poolWei={track.summary.poolWei}
      contributors={track.summary.contributors}
      agent={track.agent}
      lines={lines}
    />
  );
}
