import { beforeEach, describe, expect, it, vi } from 'vitest';

const parse = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { parse };
    static APIError = class extends Error {};
  }
  return { default: Anthropic };
});

describe('anthropic completer', () => {
  beforeEach(() => parse.mockReset());

  it('calls messages.parse with the configured model, structured output and a low effort, and returns parsed_output', async () => {
    const { createAnthropicCompleter } = await import('./anthropic');
    parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: { additions: [] } });
    const complete = createAnthropicCompleter({ apiKey: 'sk-test', model: 'claude-sonnet-5', timeoutMs: 1234 });
    const out = await complete({ system: 'sys', user: 'usr' });
    expect(out).toEqual({ additions: [] });
    const [params, options] = parse.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(params.model).toBe('claude-sonnet-5');
    expect(params.system).toBe('sys');
    expect(params.messages).toEqual([{ role: 'user', content: 'usr' }]);
    expect(params.output_config).toEqual(expect.objectContaining({ effort: 'low', format: expect.anything() }));
    expect(params).not.toHaveProperty('temperature');
    expect(options.timeout).toBe(1234);
  });

  it('throws when the model refuses or the output could not be parsed', async () => {
    const { createAnthropicCompleter } = await import('./anthropic');
    const complete = createAnthropicCompleter({ apiKey: 'sk-test', model: 'claude-sonnet-5', timeoutMs: 1000 });
    parse.mockResolvedValue({ stop_reason: 'refusal', parsed_output: null, stop_details: { category: 'x' } });
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/refus/i);
    parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: null });
    await expect(complete({ system: 's', user: 'u' })).rejects.toThrow(/parse/i);
  });
});
