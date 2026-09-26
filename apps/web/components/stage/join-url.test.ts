import { describe, expect, it } from 'vitest';
import { isLaptopOnlyOrigin, stageWarnings } from './join-url';

describe('isLaptopOnlyOrigin', () => {
  it('flags loopback and private ranges', () => {
    for (const u of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://192.168.1.4:3000', 'http://10.0.0.2', 'http://172.16.5.5', 'http://[::1]:3000']) {
      expect(isLaptopOnlyOrigin(u)).toBe(true);
    }
  });
  it('accepts public hosts and tolerates junk', () => {
    expect(isLaptopOnlyOrigin('https://abc-def.trycloudflare.com')).toBe(false);
    expect(isLaptopOnlyOrigin('https://blockbeat.example')).toBe(false);
    expect(isLaptopOnlyOrigin('')).toBe(false);
    expect(isLaptopOnlyOrigin('not a url')).toBe(false);
  });
});

describe('stageWarnings', () => {
  it('is empty on a live chain with a public join URL', () => {
    expect(stageWarnings({ source: 'ws', joinBase: 'https://x.trycloudflare.com', joinBaseFromEnv: true })).toEqual([]);
  });
  it('warns about the simulator', () => {
    const w = stageWarnings({ source: 'mock', joinBase: 'https://x.trycloudflare.com', joinBaseFromEnv: true });
    expect(w.map((x) => x.id)).toEqual(['mock']);
  });
  it('warns when the QR would encode the laptop origin', () => {
    const w = stageWarnings({ source: 'ws', joinBase: 'http://localhost:3000', joinBaseFromEnv: false });
    expect(w.map((x) => x.id)).toEqual(['local-qr']);
  });
  it('does not warn about a private join URL that was set on purpose', () => {
    expect(stageWarnings({ source: 'ws', joinBase: 'http://192.168.0.9:3000', joinBaseFromEnv: true })).toEqual([]);
  });
  it('stacks both warnings', () => {
    const w = stageWarnings({ source: 'mock', joinBase: 'http://localhost:3000', joinBaseFromEnv: false });
    expect(w.map((x) => x.id)).toEqual(['mock', 'local-qr']);
  });
});
