import { describe, expect, it, vi } from 'vitest';
import { selectBrain } from './select';
import type { Completer } from './llm';

const completer: Completer = async () => ({ additions: [] });

describe('selectBrain (W12)', () => {
  const deps = () => ({ anthropic: vi.fn(() => completer), openai: vi.fn(() => completer), gemini: vi.fn(() => completer) });

  it('builds the Claude brain with its model and timeout', () => {
    const d = deps();
    const s = selectBrain({ brain: 'anthropic', anthropicApiKey: 'sk-a', model: 'claude-sonnet-5', openaiApiKey: null, openaiModel: 'gpt-6-luna', openaiReasoningEffort: null, geminiApiKey: null, geminiModel: 'g', geminiRpm: 5, llmTimeoutMs: 3000 }, d);
    expect(s.primary?.mode).toBe('anthropic');
    expect(s.label).toBe('anthropic claude-sonnet-5 with rules fallback (timeout 3000 ms)');
    expect(d.anthropic).toHaveBeenCalledWith({ apiKey: 'sk-a', model: 'claude-sonnet-5', timeoutMs: 3000 });
    expect(d.openai).not.toHaveBeenCalled();
  });

  it('builds the OpenAI brain with its model and timeout', () => {
    const d = deps();
    const s = selectBrain({ brain: 'openai', anthropicApiKey: 'sk-a', model: 'claude-sonnet-5', openaiApiKey: 'sk-o', openaiModel: 'gpt-6-luna', openaiReasoningEffort: 'none', geminiApiKey: null, geminiModel: 'g', geminiRpm: 5, llmTimeoutMs: 3000 }, d);
    expect(s.primary?.mode).toBe('openai');
    expect(s.label).toBe('openai gpt-6-luna with rules fallback (timeout 3000 ms, effort none)');
    expect(d.openai).toHaveBeenCalledWith({ apiKey: 'sk-o', model: 'gpt-6-luna', timeoutMs: 3000, reasoningEffort: 'none' });
  });

  it('runs rules only when asked or when there is no key', () => {
    const d = deps();
    expect(selectBrain({ brain: 'rules', anthropicApiKey: 'sk-a', model: 'x', openaiApiKey: 'sk-o', openaiModel: 'y', openaiReasoningEffort: null, geminiApiKey: 'g', geminiModel: 'z', geminiRpm: 5, llmTimeoutMs: 3000 }, d)).toEqual({ primary: null, label: 'rules' });
    expect(selectBrain({ brain: 'openai', anthropicApiKey: null, model: 'x', openaiApiKey: null, openaiModel: 'y', openaiReasoningEffort: null, geminiApiKey: null, geminiModel: 'z', geminiRpm: 5, llmTimeoutMs: 3000 }, d)).toEqual({ primary: null, label: 'rules' });
    expect(d.anthropic).not.toHaveBeenCalled();
    expect(d.openai).not.toHaveBeenCalled();
    expect(d.gemini).not.toHaveBeenCalled();
  });

  it('builds the Gemini brain with its model and timeout, and its model shows in the label (W14)', () => {
    const d = deps();
    const s = selectBrain({ brain: 'gemini', anthropicApiKey: null, model: 'x', openaiApiKey: null, openaiModel: 'y', openaiReasoningEffort: null, geminiApiKey: 'g-key', geminiModel: 'gemini-3.8-flash', geminiRpm: 5, llmTimeoutMs: 4000 }, d);
    expect(s.primary?.mode).toBe('gemini');
    expect(s.primary?.model).toBe('gemini-3.8-flash');
    expect(s.label).toBe('gemini gemini-3.8-flash with rules fallback (timeout 4000 ms)');
    expect(s.label).not.toContain('g-key');
    expect(d.gemini).toHaveBeenCalledWith({ apiKey: 'g-key', model: 'gemini-3.8-flash', timeoutMs: 4000, maxPerMinute: 5 });
    expect(selectBrain({ brain: 'gemini', anthropicApiKey: null, model: 'x', openaiApiKey: null, openaiModel: 'y', openaiReasoningEffort: null, geminiApiKey: null, geminiModel: 'z', geminiRpm: 5, llmTimeoutMs: 4000 }, d)).toEqual({ primary: null, label: 'rules' });
  });
});
