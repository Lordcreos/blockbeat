import { describe, expect, it } from 'vitest';
import { MUTE_DB as STAGE_MUTE_DB, volumeToDb as stageVolumeToDb } from '@/components/stage/useStageAudio';
import { MUTE_DB, volumeToDb } from './volume';

describe('track volume curve', () => {
  it('is the stage curve, value for value', () => {
    expect(MUTE_DB).toBe(STAGE_MUTE_DB);
    for (const v of [-1, 0, 0.001, 0.1, 0.25, 0.5, 0.8, 0.99, 1, 2, Number.NaN]) {
      expect(volumeToDb(v)).toBe(stageVolumeToDb(v));
    }
  });
});
