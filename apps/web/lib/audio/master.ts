/**
 * Master chain: volume -> gentle bus compressor -> brick-wall limiter -> destination.
 * A full room triggering every track at once must not clip a laptop-plus-speaker rig.
 */
import * as Tone from 'tone';

export interface MasterChain {
  /** Where the kit connects. */
  readonly input: Tone.InputNode;
  setVolumeDb(db: number): void;
  dispose(): void;
}

export const MASTER_COMPRESSOR = { threshold: -18, ratio: 3, attack: 0.005, release: 0.12, knee: 6 } as const;
export const MASTER_LIMITER_DB = -1;
/** Fixed makeup gain so a normal groove sits near the limiter instead of 6 dB under it. */
export const MASTER_MAKEUP_DB = 3;

export function createMasterChain(): MasterChain {
  const volume = new Tone.Volume(0);
  const makeup = new Tone.Volume(MASTER_MAKEUP_DB);
  const compressor = new Tone.Compressor(MASTER_COMPRESSOR);
  const limiter = new Tone.Limiter(MASTER_LIMITER_DB);
  volume.chain(makeup, compressor, limiter, Tone.getDestination());
  return {
    input: volume,
    setVolumeDb(db) {
      volume.volume.value = Number.isFinite(db) ? db : 0;
    },
    dispose() {
      volume.dispose();
      makeup.dispose();
      compressor.dispose();
      limiter.dispose();
    },
  };
}
