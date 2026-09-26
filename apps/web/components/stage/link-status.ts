import type { BlockClockState } from '@/lib/types';

export type LinkLevel = 'ok' | 'stale' | 'error';

export interface LinkStatus {
  level: LinkLevel;
  label: string;
}

interface LinkInputs {
  source: BlockClockState['source'];
  connected: boolean;
  /** ms since the last head arrived; the clock free-runs past this, so the UI must say so. */
  msSinceHead: number;
  error: string | null;
  chainName: string;
}

/** A head is expected every 300 ms; five missed blocks is a stall worth showing. */
export const STALE_AFTER_MS = 1500;

/** What the stage says about its link to the chain, worst condition first. */
export function linkStatus({ source, connected, msSinceHead, error, chainName }: LinkInputs): LinkStatus {
  if (error) return { level: 'error', label: `Feed error: ${error}` };
  if (source === 'mock') return { level: 'ok', label: 'Mock clock, no chain' };
  if (!connected) return { level: 'error', label: `Not connected to ${chainName}` };
  if (msSinceHead > STALE_AFTER_MS) return { level: 'stale', label: `No block for ${Math.round(msSinceHead / 1000)} s` };
  return { level: 'ok', label: source === 'ws' ? `Live on ${chainName}` : `Polling ${chainName}` };
}
