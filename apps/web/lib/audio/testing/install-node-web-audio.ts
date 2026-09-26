/**
 * TEST AND SCRIPT ONLY. Installs node-web-audio-api as the WebAudio implementation so Tone.js
 * can render through an OfflineAudioContext under Node/Vitest. Import this module before
 * anything that imports `tone`.
 *
 * `AudioContext` is deliberately NOT exposed: Tone would otherwise open a real audio device
 * on import, which hangs headless runs. Only offline rendering is supported here.
 */
import webaudio from 'node-web-audio-api';

const { AudioContext: _realtime, mediaDevices: _media, ...offlineOnly } = webaudio as Record<string, unknown>;
void _realtime;
void _media;

const g = globalThis as Record<string, unknown>;
g.TONE_SILENCE_LOGGING = true;
Object.assign(g, offlineOnly);
// Plain Node (the demo script) has neither `window` nor `self`; Tone and
// standardized-audio-context look the constructors up there.
if (typeof g.window !== 'object' || g.window === null) g.window = g;
if (typeof g.self !== 'object' || g.self === null) g.self = g;
for (const scope of [g.window, g.self]) {
  if (scope !== g) Object.assign(scope as Record<string, unknown>, offlineOnly);
}
