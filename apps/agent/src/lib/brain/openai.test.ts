import { describe, expect, it, vi } from 'vitest';
import { createOpenAiCompleter, OPENAI_RESPONSES_URL } from './openai';
import { PHRASE_JSON_SCHEMA } from './types';
import { failureClass } from './fallback';

type FetchArgs = [string, RequestInit];

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PLAN = { additions: [{ step: 13, track: 2, note: 0, role: 'hat offbeat' }] };

function completed(text: string) {
  return { id: 'resp_1', status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text }] }] };
}

describe('openai completer (W12)', () => {
  it('posts to the Responses API with a strict JSON schema, the model and the key, and parses the output text', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => reply(completed(JSON.stringify(PLAN))));
    const complete = createOpenAiCompleter({ apiKey: 'sk-test', model: 'gpt-6-luna', timeoutMs: 3000, fetch: fetchMock });
    await expect(complete({ system: 'sys', user: 'usr' })).resolves.toEqual(PLAN);
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url).toBe(OPENAI_RESPONSES_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-6-luna');
    expect(body.input).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'blockbeat_phrase', schema: PHRASE_JSON_SCHEMA, strict: true } });
    expect(body.store).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body).not.toHaveProperty('reasoning');
  });

  it('W14b: sends reasoning.effort when configured (luna: none)', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => reply(completed(JSON.stringify(PLAN))));
    const complete = createOpenAiCompleter({ apiKey: 'k', model: 'gpt-6-luna', timeoutMs: 4000, reasoningEffort: 'none', fetch: fetchMock });
    await complete({ system: 's', user: 'u' });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as FetchArgs)[1].body)) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  it('W14b: retries once on 429 / 5xx inside the same deadline, then gives up', async () => {
    const seq = [reply({ error: { message: 'Rate limit' } }, 429), reply(completed(JSON.stringify(PLAN)))];
    const fetchMock = vi.fn(async (..._args: FetchArgs) => seq.shift() ?? reply({}, 500));
    const complete = createOpenAiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 2000, retryDelayMs: 1, fetch: fetchMock });
    await expect(complete({ system: 's', user: 'u' })).resolves.toEqual(PLAN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as FetchArgs)[1].signal).toBe((fetchMock.mock.calls[0] as FetchArgs)[1].signal);

    const bad = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    const c2 = createOpenAiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 2000, retryDelayMs: 1, fetch: bad });
    await expect(c2({ system: 's', user: 'u' })).rejects.toThrow(/^openai 502/);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it('W14b: the deadline cuts the retry pause short (no second request after the deadline)', async () => {
    const f = vi.fn(async () => reply({ error: { message: 'busy' } }, 503));
    const c = createOpenAiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 40, retryDelayMs: 5_000, fetch: f });
    const t0 = Date.now();
    await expect(c({ system: 's', user: 'u' })).rejects.toThrow(/timed out after 40 ms/);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('W14b: a 2xx that is not JSON is bad output, not an HTTP error, and is not retried', async () => {
    const f = vi.fn(async () => new Response('<html>ok?</html>', { status: 200 }));
    const c = createOpenAiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 1000, retryDelayMs: 1, fetch: f });
    const error = await c({ system: 's', user: 'u' }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/openai returned 200 with a non-JSON body/);
    expect(failureClass(error)).toBe('bad output');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('W14b: a real HTTP error that arrives as the deadline fires keeps its status (not relabelled timeout)', async () => {
    // The response ignores the abort and resolves after the deadline: the error is the 401, not the clock.
    const late = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return reply({ error: { message: 'Incorrect API key' } }, 401);
    });
    const c = createOpenAiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 20, fetch: late });
    await expect(c({ system: 's', user: 'u' })).rejects.toThrow(/^openai 401/);
  });

  it('W14b: does not retry 400 / 401 / 403 / 404', async () => {
    for (const status of [400, 401, 403, 404]) {
      const f = vi.fn(async () => reply({ error: { message: 'nope' } }, status));
      const c = createOpenAiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 2000, retryDelayMs: 1, fetch: f });
      await expect(c({ system: 's', user: 'u' })).rejects.toThrow(new RegExp(`^openai ${status}`));
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('W14b: redacts the key if a provider or transport message echoes it', async () => {
    const echo = vi.fn(async () => reply({ error: { message: 'Incorrect API key provided: sk-very-secret-123' } }, 401));
    const e1 = await createOpenAiCompleter({ apiKey: 'sk-very-secret-123', model: 'm', timeoutMs: 1000, fetch: echo })({ system: 's', user: 'u' }).catch((e: unknown) => e);
    expect(String(e1)).not.toContain('sk-very-secret-123');
    const net = vi.fn(async () => {
      throw new TypeError('fetch failed sk-very-secret-123');
    });
    const e2 = await createOpenAiCompleter({ apiKey: 'sk-very-secret-123', model: 'm', timeoutMs: 1000, fetch: net })({ system: 's', user: 'u' }).catch((e: unknown) => e);
    expect(String(e2)).toMatch(/openai request failed/);
    expect(String(e2)).not.toContain('sk-very-secret-123');
  });

  it('throws on a refusal, an incomplete response and output that is not JSON', async () => {
    const make = (body: unknown) => createOpenAiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 1000, fetch: vi.fn(async () => reply(body)) });
    await expect(make({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })({ system: 's', user: 'u' })).rejects.toThrow(/refus/i);
    await expect(make({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })({ system: 's', user: 'u' })).rejects.toThrow(/incomplete.*max_output_tokens/);
    await expect(make(completed('not json'))({ system: 's', user: 'u' })).rejects.toThrow(/parse/i);
    await expect(make({ status: 'completed', output: [] })({ system: 's', user: 'u' })).rejects.toThrow(/no output text/i);
  });

  it('reports an HTTP error with its status and message but never the key', async () => {
    const complete = createOpenAiCompleter({
      apiKey: 'sk-very-secret',
      model: 'm',
      timeoutMs: 1000,
      fetch: vi.fn(async () => reply({ error: { message: 'Rate limit reached', type: 'rate_limit' } }, 429)),
    });
    const error = await complete({ system: 's', user: 'u' }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/429.*Rate limit reached/);
    expect(String(error)).not.toContain('sk-very-secret');
  });

  it('gives up after the timeout (the 3 s bar budget) with a clear reason', async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const complete = createOpenAiCompleter({ apiKey: 'k', model: 'm', timeoutMs: 30, fetch: hang });
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/timed out after 30 ms/);
  });
});
