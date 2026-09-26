import { describe, expect, it } from 'vitest';
import { rpcOrigin, createLogger, redactSecrets } from './log';

describe('logger', () => {
  it('prefixes lines with a time stamp and marks warnings', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.info('hello');
    log.warn('careful');
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} hello$/);
    expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} WARN careful$/);
  });
});

describe('rpcOrigin', () => {
  it('keeps only the origin so a provider key in the path never reaches the terminal', () => {
    expect(rpcOrigin('https://monad-testnet.g.alchemy.com/v2/secret-key')).toBe('https://monad-testnet.g.alchemy.com');
    expect(rpcOrigin('wss://host.example/ws?token=abc')).toBe('wss://host.example');
    expect(rpcOrigin('http://127.0.0.1:8545')).toBe('http://127.0.0.1:8545');
    expect(rpcOrigin('not a url')).toBe('<invalid url>');
  });
});

describe('logger redaction (W14)', () => {
  it('drops anything shaped like a provider API key from every line, whoever logged it', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    const google = `AIza${'Sy0123456789abcdefghijklmnopqrstu'}`;
    log.warn(`brain: gemini failed (gemini 400: API key ${google} not valid); using rules for this bar`);
    log.info('openai key sk-proj-abcdefghijklmnop1234 and claude sk-ant-api03-abcdefghijklmnop');
    expect(lines.join('\n')).not.toContain(google);
    expect(lines.join('\n')).not.toMatch(/sk-(proj|ant)-/);
    expect(lines[0]).toContain('AIza…redacted');
    expect(redactSecrets('brain gemini gemini-3.8-flash | skip 3')).toBe('brain gemini gemini-3.8-flash | skip 3');
  });
});
