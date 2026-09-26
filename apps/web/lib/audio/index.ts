/**
 * Blockbeat audio engine (W4). Framework-agnostic: no React in here.
 *
 *   const engine = createAudioEngine();
 *   button.onclick = () => { engine.start().catch(console.error); }; // user gesture, idempotent
 *   engine.setPattern(pattern);
 *   const off = engine.attachClock(blockClock);
 *   engine.playImmediate(track, note);       // a hit that landed on the current step
 *   ...
 *   off(); engine.dispose();                 // ALWAYS dispose (React effect cleanup, Fast
 *                                            // Refresh): every engine wires its own master
 *                                            // chain into the one global destination.
 */
export { createAudioEngine, DEFAULT_RESUME_TIMEOUT_MS } from './engine';
export type { AudioContextAdapter, EngineDeps, Kit, MasterChain } from './engine';
export type { AudioEngine } from '../types';
export { KIT_KEYS, PAD_CHORDS, assertTrackNote, midiToHz, noteVariant } from './kitSpec';
export type { KitKey, NoteVariant } from './kitSpec';
export { createKit, VOICE_TRIM_DB } from './kit';
export { createMasterChain, MASTER_COMPRESSOR, MASTER_LIMITER_DB } from './master';
export { PatternPlayer, assertPattern, DEFAULT_LATE_TOLERANCE_SEC, DEFAULT_MIN_LEAD_SEC } from './patternPlayer';
export type { PatternPlayerOptions, TriggerSink } from './patternPlayer';
export { ScriptedClock, renderPattern, renderTriggers } from './render';
export type { RenderOptions, Trigger } from './render';
export { encodeWav16 } from './wav';
