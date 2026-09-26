import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PHRASE_JSON_SCHEMA } from './types';

const generateContent = vi.fn();
const constructed: Array<Record<string, unknown>> = [];

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = { generateContent };
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
  }
  class ApiError extends Error {
    status: number;
    constructor(options: { message: string; status: number }) {
      super(options.message);
      this.name = 'ApiError';
      this.status = options.status;
    }
  }
  return { GoogleGenAI, ApiError, ThinkingLevel: { MINIMAL: 'MINIMAL', LOW: 'LOW' } };
});

const PLAN = { additions: [{ step: 13, track: 2, note: 0, role: 'hat offbeat' }] };

function ok(text: string | undefined, finishReason = 'STOP') {
  return { text, candidates: [{ finishReason }] };
}

type Call = [{ model: string; contents: unknown; config: Record<string, unknown> }];

describe('gemini completer (W14)', () => {
  beforeEach(() => {
    generateContent.mockReset();
    constructed.length = 0;
  });

  it('calls models.generateContent with the model, system instruction, JSON schema output and no retries, and parses the text', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    generateContent.mockResolvedValue(ok(JSON.stringify(PLAN)));
    const complete = createGeminiCompleter({ apiKey: 'g-test', model: 'gemini-3.8-flash', timeoutMs: 2500 });
    await expect(complete({ system: 'sys', user: 'usr' })).resolves.toEqual(PLAN);
    expect(constructed[0]).toMatchObject({ apiKey: 'g-test' });
    const [req] = generateContent.mock.calls[0] as Call;
    expect(req.model).toBe('gemini-3.8-flash');
    expect(req.contents).toEqual([{ role: 'user', parts: [{ text: 'usr' }] }]);
    expect(req.config.systemInstruction).toBe('sys');
    expect(req.config.responseMimeType).toBe('application/json');
    expect(req.config.responseJsonSchema).toEqual(PHRASE_JSON_SCHEMA);
    expect(req.config.abortSignal).toBeInstanceOf(AbortSignal);
    // One deadline (the abort signal); attempts counts the original request, so 1 = no retries.
    expect(req.config.httpOptions).toEqual({ retryOptions: { attempts: 1 } });
    expect(req.config.candidateCount).toBe(1);
  });

  it('keeps thinking as small as the model allows (latency over depth)', async () => {
    const { thinkingConfigFor } = await import('./gemini');
    expect(thinkingConfigFor('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfigFor('gemini-2.5-flash-lite')).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfigFor('gemini-3.5-flash')).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(thinkingConfigFor('gemini-3.6-flash')).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(thinkingConfigFor('gemini-3.5-flash-lite')).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(thinkingConfigFor('gemini-3.8-flash')).toEqual({ thinkingLevel: 'LOW' });
    expect(thinkingConfigFor('gemini-3.7-flash')).toEqual({ thinkingLevel: 'LOW' });
    expect(thinkingConfigFor('models/gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
  });

  it('sends the thinking config for its model', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    generateContent.mockResolvedValue(ok(JSON.stringify(PLAN)));
    await createGeminiCompleter({ apiKey: 'k', model: 'gemini-2.5-flash', timeoutMs: 1000 })({ system: 's', user: 'u' });
    const [req] = generateContent.mock.calls[0] as Call;
    expect(req.config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('throws on a blocked prompt, a safety or max-tokens stop, no text and text that is not JSON', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    const complete = createGeminiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 1000 });
    generateContent.mockResolvedValueOnce({ text: undefined, promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/refused.*SAFETY/i);
    generateContent.mockResolvedValueOnce(ok(undefined, 'SAFETY'));
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/refused.*SAFETY/i);
    generateContent.mockResolvedValueOnce(ok('{"additions":[', 'MAX_TOKENS'));
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/incomplete.*MAX_TOKENS/);
    generateContent.mockResolvedValueOnce(ok(undefined));
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/no output text/i);
    generateContent.mockResolvedValueOnce(ok('not json'));
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/parse/i);
  });

  it('reports an API error with its status but never the key', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    const { ApiError } = await import('@google/genai');
    const ApiErrorCtor = ApiError as unknown as new (o: { message: string; status: number }) => Error;
    generateContent.mockRejectedValue(new ApiErrorCtor({ message: 'Resource has been exhausted (key g-very-secret)', status: 429 }));
    const complete = createGeminiCompleter({ apiKey: 'g-very-secret', model: 'm', timeoutMs: 1000 });
    const error = await complete({ system: 's', user: 'u' }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/gemini 429/);
    expect(String(error)).not.toContain('g-very-secret');
  });

  it('retries once on 503 / 429 inside the same deadline, then gives up (coordinator: then rules)', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    const { ApiError } = await import('@google/genai');
    const Err = ApiError as unknown as new (o: { message: string; status: number }) => Error;
    const complete = createGeminiCompleter({ apiKey: 'k', model: 'gemini-3.6-flash', timeoutMs: 2000, retryDelayMs: 1 });
    generateContent.mockRejectedValueOnce(new Err({ message: 'high demand', status: 503 })).mockResolvedValueOnce(ok(JSON.stringify(PLAN)));
    await expect(complete({ system: 's', user: 'u' })).resolves.toEqual(PLAN);
    expect(generateContent).toHaveBeenCalledTimes(2);
    const [a] = generateContent.mock.calls[0] as Call;
    const [b] = generateContent.mock.calls[1] as Call;
    expect(b.config.abortSignal).toBe(a.config.abortSignal);
    generateContent.mockReset();
    generateContent.mockRejectedValue(new Err({ message: 'quota', status: 429 }));
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/gemini 429/);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('caps calls per minute on the client (free tier: 5 per model) and refuses the rest at once', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    let now = 1_000_000;
    generateContent.mockResolvedValue(ok(JSON.stringify(PLAN)));
    const complete = createGeminiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 1000, maxPerMinute: 2, now: () => now });
    await complete({ system: 's', user: 'u' });
    now += 10_000;
    await complete({ system: 's', user: 'u' });
    now += 10_000;
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/gemini rate cap \(2\/min\)/);
    expect(generateContent).toHaveBeenCalledTimes(2);
    now += 41_000; // the first call left the 60 s window
    await expect(complete({ system: 's', user: 'u' })).resolves.toEqual(PLAN);
    expect(generateContent).toHaveBeenCalledTimes(3);
    const unlimited = createGeminiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 1000, maxPerMinute: 0, now: () => now });
    for (let i = 0; i < 5; i++) await unlimited({ system: 's', user: 'u' });
    expect(generateContent).toHaveBeenCalledTimes(8);
  });

  it('does not retry a permanent error (400 / 401 / 403 / 404)', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    const { ApiError } = await import('@google/genai');
    const Err = ApiError as unknown as new (o: { message: string; status: number }) => Error;
    const complete = createGeminiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 2000, retryDelayMs: 1 });
    for (const status of [400, 401, 403, 404]) {
      generateContent.mockReset();
      generateContent.mockRejectedValue(new Err({ message: '', status }));
      await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(new RegExp(`gemini ${status}`));
      expect(generateContent).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a real API error that arrives after the deadline fired (not relabelled timeout)', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    const { ApiError } = await import('@google/genai');
    const Err = ApiError as unknown as new (o: { message: string; status: number }) => Error;
    generateContent.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      throw new Err({ message: 'not found', status: 404 });
    });
    const complete = createGeminiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 20 });
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/^gemini 404/);
  });

  it('gives up after the timeout with a clear reason', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    generateContent.mockImplementation(
      (req: Call[0]) =>
        new Promise((_, reject) => {
          const signal = req.config.abortSignal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const complete = createGeminiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 30 });
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/gemini request timed out after 30 ms/);
  });

  it('turns a transport failure into a gemini error without the key', async () => {
    const { createGeminiCompleter } = await import('./gemini');
    generateContent.mockRejectedValue(new TypeError('fetch failed for key=k-secret'));
    const complete = createGeminiCompleter({ apiKey: 'k-secret', model: 'm', timeoutMs: 1000 });
    const error = await complete({ system: 's', user: 'u' }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/gemini request failed/);
    expect(String(error)).not.toContain('k-secret');
  });
});
