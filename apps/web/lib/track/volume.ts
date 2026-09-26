/**
 * W15: slider position 0..1 to master gain in dB, the same curve as the stage
 * (components/stage/useStageAudio `volumeToDb`, pinned equal by volume.test.ts). Kept here so
 * the track pages do not import the stage hook, whose module graph loads Tone (and with it an
 * AudioContext) before any click.
 */
export const MUTE_DB = -100;

export function volumeToDb(volume: number): number {
  if (!Number.isFinite(volume) || volume <= 0) return MUTE_DB;
  if (volume >= 1) return 0;
  return Math.max(MUTE_DB, 20 * Math.log10(volume));
}
