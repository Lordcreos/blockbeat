/**
 * Production Completer backed by the Anthropic SDK with structured (JSON schema) output.
 * The model id comes from config (SDD: claude-sonnet-5). Sonnet 5 rejects `temperature`,
 * so determinism is asked for through the prompt and a low effort level instead.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Completer } from './llm';
import { phraseSchema } from './types';

export interface AnthropicCompleterOptions {
  apiKey: string;
  model: string;
  /** Hard request timeout; a bar is 4.8 s so this must stay well under that. */
  timeoutMs: number;
}

export function createAnthropicCompleter(options: AnthropicCompleterOptions): Completer {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
  return async ({ system, user }) => {
    const response = await client.messages.parse(
      {
        model: options.model,
        max_tokens: 512,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'low', format: zodOutputFormat(phraseSchema) },
      },
      { timeout: options.timeoutMs },
    );
    if (response.stop_reason === 'refusal') {
      throw new Error(`model refused (${response.stop_details?.category ?? 'unknown category'})`);
    }
    if (response.parsed_output === null) {
      throw new Error(`could not parse model output (stop_reason=${response.stop_reason})`);
    }
    return response.parsed_output;
  };
}
