/**
 * W12: production Completer backed by the OpenAI Responses API (POST /v1/responses) with a
 * strict JSON-schema structured output (PHRASE_JSON_SCHEMA). Plain fetch, no SDK dependency;
 * the fetch is injectable so tests never touch the network. Same contract as the other
 * completers: resolve with the parsed JSON, throw on refusal, incomplete output, bad JSON,
 * HTTP errors and the timeout (the fallback brain then plays the rules for that bar).
 *
 * W14b (the live DJ brain): `reasoning.effort` from OPENAI_REASONING_EFFORT (gpt-6-luna: none,
 * 1.5-3.5 s measured by the coordinator), one deadline per call (the Gemini pattern), one retry on
 * 429 / 5xx inside that deadline, none on 400 / 401 / 403 / 404. The key goes only into the
 * Authorization header and is redacted from any message that might echo it.
 */
import { isDeadline, pause, redactKey } from './deadline';
import type { Completer } from './llm';
import { PHRASE_JSON_SCHEMA } from './types';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export interface OpenAiCompleterOptions {
  apiKey: string;
  model: string;
  /** Hard deadline for the call, the one retry included; the loop plans the next bar (4.8 s). */
  timeoutMs: number;
  /** Responses API reasoning.effort; omitted (model default) when null or absent. */
  reasoningEffort?: string | null;
  /** Pause before the single retry on 429 / 5xx (default 250 ms). */
  retryDelayMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

interface ResponsesContent {
  type?: unknown;
  text?: unknown;
  refusal?: unknown;
}

interface ResponsesBody {
  status?: unknown;
  incomplete_details?: { reason?: unknown } | null;
  output?: Array<{ type?: unknown; content?: ResponsesContent[] }>;
  error?: { message?: unknown } | null;
}

/** An HTTP error from the API, kept typed so the retry decision reads the status. */
class OpenAiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenAiHttpError';
  }
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createOpenAiCompleter(options: OpenAiCompleterOptions): Completer {
  const doFetch = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const effort = options.reasoningEffort ?? null;
  return async ({ system, user }) => {
    const signal = AbortSignal.timeout(options.timeoutMs);
    const payload = JSON.stringify({
      model: options.model,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      text: { format: { type: 'json_schema', name: 'blockbeat_phrase', schema: PHRASE_JSON_SCHEMA, strict: true } },
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: 1024,
      store: false,
    });

    /** One POST; resolves with the parsed body of a 2xx, throws OpenAiHttpError otherwise. */
    const post = async (): Promise<ResponsesBody> => {
      const res = await doFetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: payload,
        signal,
      });
      const text = await res.text();
      let body: ResponsesBody | null = null;
      try {
        body = JSON.parse(text) as ResponsesBody;
      } catch (error) {
        // A proxy's HTML error page is still an HTTP error; a 2xx that is not JSON is bad output.
        if (res.ok) throw new Error(`openai returned ${res.status} with a non-JSON body (${error instanceof Error ? error.message : String(error)})`);
      }
      if (!res.ok) {
        const message = typeof body?.error?.message === 'string' ? body.error.message : 'non-JSON body';
        throw new OpenAiHttpError(res.status, `openai ${res.status}: ${redactKey(message, options.apiKey)}`);
      }
      return body ?? {};
    };

    let body: ResponsesBody;
    try {
      try {
        body = await post();
      } catch (error) {
        if (!(error instanceof OpenAiHttpError) || !retryable(error.status)) throw error;
        await pause(options.retryDelayMs ?? 250, signal);
        body = await post();
      }
    } catch (error) {
      // A real HTTP answer wins over the clock: it can arrive just as the deadline fires (review).
      if (error instanceof OpenAiHttpError) throw new Error(error.message);
      if (isDeadline(error, signal)) throw new Error(`openai request timed out after ${options.timeoutMs} ms`);
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('openai returned')) throw new Error(redactKey(message, options.apiKey));
      throw new Error(`openai request failed: ${redactKey(message, options.apiKey)}`);
    }

    if (body.status === 'incomplete') {
      throw new Error(`openai response incomplete (${String(body.incomplete_details?.reason ?? 'unknown reason')})`);
    }
    const contents = (body.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
    const refusal = contents.find((c) => c.type === 'refusal');
    if (refusal) throw new Error(`model refused (${typeof refusal.refusal === 'string' ? refusal.refusal.slice(0, 120) : 'no reason'})`);
    const text = contents.find((c) => c.type === 'output_text' && typeof c.text === 'string')?.text;
    if (typeof text !== 'string') throw new Error(`openai returned no output text (status ${String(body.status)})`);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`could not parse model output as JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  };
}
