/**
 * W14: production Completer backed by the Google Gen AI SDK (@google/genai,
 * models.generateContent) with JSON output (responseMimeType application/json +
 * responseJsonSchema = PHRASE_JSON_SCHEMA). Same contract as the other completers: resolve with
 * the parsed JSON, throw on a blocked prompt, a safety or max-tokens stop, bad JSON, API
 * errors and the timeout (the fallback brain then plays the rules for that bar).
 * No SDK retries; one retry on 429 / 503 inside the same deadline (coordinator), none on a
 * permanent 400 / 401 / 403 / 404, which the fallback labels "gemini unavailable". Thinking is kept as small as
 * the model allows, since a DJ fill is a classification-sized task and latency is the budget.
 * The key goes only into the client and never into an error message.
 */
import { ApiError, GoogleGenAI, ThinkingLevel, type ThinkingConfig } from '@google/genai';
import { isDeadline, pause, redactKey } from './deadline';
import type { Completer } from './llm';
import { PHRASE_JSON_SCHEMA } from './types';

export interface GeminiCompleterOptions {
  apiKey: string;
  model: string;
  /** Hard deadline for the call, the one retry included; the bar loop plans one bar ahead (4.8 s). */
  timeoutMs: number;
  /** Pause before the single retry on 429 / 503 (default 250 ms). */
  retryDelayMs?: number;
  /**
   * Client-side cap on requests per rolling minute, retries included (GEMINI_RPM). A free-tier key
   * allows 5 per model per minute while the loop may ask 12.5 times a minute; over the cap the call
   * fails at once ("gemini rate cap") and the rules play that bar. 0 or absent: no cap.
   */
  maxPerMinute?: number;
  now?: () => number;
}

/** Busy or rate limited: worth one more try inside the deadline. 400 / 401 / 403 / 404 are not. */
const RETRYABLE = new Set([429, 503]);

/**
 * The smallest thinking setting each Flash generation accepts (ai.google.dev/gemini-api/docs/thinking,
 * read 2026-09-25): 2.5 turns thinking off with a zero budget; 3.5 / 3.6 and the lites accept
 * MINIMAL; newer Flash models (3.7, 3.8) accept LOW at the bottom.
 */
export function thinkingConfigFor(model: string): ThinkingConfig {
  const id = model.replace(/^models\//, '');
  if (/^gemini-2\.5-/.test(id)) return { thinkingBudget: 0 };
  if (/^gemini-3\.[56]-/.test(id) || /-lite\b/.test(id)) return { thinkingLevel: ThinkingLevel.MINIMAL };
  return { thinkingLevel: ThinkingLevel.LOW };
}

export function createGeminiCompleter(options: GeminiCompleterOptions): Completer {
  const ai = new GoogleGenAI({ apiKey: options.apiKey });
  const thinkingConfig = thinkingConfigFor(options.model);
  const now = options.now ?? Date.now;
  const cap = options.maxPerMinute ?? 0;
  const sent: number[] = [];
  /** Books one request in the rolling minute; false when the cap is reached. */
  function take(): boolean {
    if (cap <= 0) return true;
    const t = now();
    while (sent.length > 0 && (sent[0] ?? 0) <= t - 60_000) sent.shift();
    if (sent.length >= cap) return false;
    sent.push(t);
    return true;
  }
  return async ({ system, user }) => {
    if (!take()) throw new Error(`gemini rate cap (${cap}/min)`);
    const signal = AbortSignal.timeout(options.timeoutMs);
    const call = () =>
      ai.models.generateContent({
        model: options.model,
        contents: [{ role: 'user', parts: [{ text: user }] }],
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseJsonSchema: PHRASE_JSON_SCHEMA,
          candidateCount: 1,
          temperature: 0.4,
          maxOutputTokens: 1024,
          thinkingConfig,
          abortSignal: signal,
          // One deadline: the abort signal above. attempts counts the original request (1 = no SDK
          // retries); the single 429 / 503 retry below stays inside the same deadline.
          httpOptions: { retryOptions: { attempts: 1 } },
        },
      });
    let response: Awaited<ReturnType<typeof call>>;
    try {
      try {
        response = await call();
      } catch (error) {
        if (!(error instanceof ApiError) || !RETRYABLE.has(error.status) || !take()) throw error;
        await pause(options.retryDelayMs ?? 250, signal);
        response = await call();
      }
    } catch (error) {
      // A real API answer wins over the clock: it can arrive just as the deadline fires (review).
      if (error instanceof ApiError) throw new Error(`gemini ${error.status}: ${redactKey(error.message, options.apiKey)}`);
      if (isDeadline(error, signal)) throw new Error(`gemini request timed out after ${options.timeoutMs} ms`);
      throw new Error(`gemini request failed: ${redactKey(error instanceof Error ? error.message : String(error), options.apiKey)}`);
    }
    const blocked = response.promptFeedback?.blockReason;
    if (blocked) throw new Error(`model refused (prompt blocked: ${blocked})`);
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP') {
      if (finish === 'MAX_TOKENS') throw new Error(`gemini response incomplete (${finish})`);
      throw new Error(`model refused (finish reason ${finish})`);
    }
    const text = response.text;
    if (typeof text !== 'string' || text.length === 0) throw new Error(`gemini returned no output text (finish reason ${finish ?? 'none'})`);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`could not parse model output as JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  };
}
