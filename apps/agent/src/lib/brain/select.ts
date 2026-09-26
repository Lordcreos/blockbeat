/**
 * W12: AGENT_BRAIN → the primary brain (Claude, OpenAI; W14: Gemini) or none (rules only). The rules
 * brain is always the fallback, wired by main.ts through createFallbackBrain. Completer
 * factories are injected so tests never build a real client.
 */
import type { AgentConfig } from '../../config';
import { createLlmBrain, type Completer, type LlmBrainOptions } from './llm';
import type { Brain } from './types';

/** W17: what every LLM brain shares with the loop (the rules instance for its menu, the drop and debug logs). */
export type LlmBrainExtras = Pick<LlmBrainOptions, 'rules' | 'log' | 'debug'>;

export interface CompleterFactoryOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** W14: gemini only, client-side requests per minute (0 = no cap). */
  maxPerMinute?: number;
  /** W14b: openai only, Responses API reasoning.effort (null = model default). */
  reasoningEffort?: string | null;
}

export interface BrainFactories {
  anthropic: (options: CompleterFactoryOptions) => Completer;
  openai: (options: CompleterFactoryOptions) => Completer;
  gemini: (options: CompleterFactoryOptions) => Completer;
}

export type BrainSelectionConfig = Pick<AgentConfig, 'brain' | 'anthropicApiKey' | 'model' | 'openaiApiKey' | 'openaiModel' | 'openaiReasoningEffort' | 'geminiApiKey' | 'geminiModel' | 'geminiRpm' | 'llmTimeoutMs'>;

export function selectBrain(config: BrainSelectionConfig, factories: BrainFactories, extras: LlmBrainExtras = {}): { primary: Brain | null; label: string } {
  const timeoutMs = config.llmTimeoutMs;
  if (config.brain === 'anthropic' && config.anthropicApiKey) {
    const complete = factories.anthropic({ apiKey: config.anthropicApiKey, model: config.model, timeoutMs });
    return { primary: createLlmBrain({ ...extras, complete, model: config.model, provider: 'anthropic' }), label: `anthropic ${config.model} with rules fallback (timeout ${timeoutMs} ms)` };
  }
  if (config.brain === 'openai' && config.openaiApiKey) {
    const complete = factories.openai({ apiKey: config.openaiApiKey, model: config.openaiModel, timeoutMs, reasoningEffort: config.openaiReasoningEffort });
    const effort = config.openaiReasoningEffort ? `, effort ${config.openaiReasoningEffort}` : '';
    return { primary: createLlmBrain({ ...extras, complete, model: config.openaiModel, provider: 'openai' }), label: `openai ${config.openaiModel} with rules fallback (timeout ${timeoutMs} ms${effort})` };
  }
  if (config.brain === 'gemini' && config.geminiApiKey) {
    const complete = factories.gemini({ apiKey: config.geminiApiKey, model: config.geminiModel, timeoutMs, maxPerMinute: config.geminiRpm });
    return { primary: createLlmBrain({ ...extras, complete, model: config.geminiModel, provider: 'gemini' }), label: `gemini ${config.geminiModel} with rules fallback (timeout ${timeoutMs} ms)` };
  }
  return { primary: null, label: 'rules' };
}
