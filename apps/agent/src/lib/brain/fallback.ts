/**
 * Composite brain: try the LLM, fall back to the rules on any error (timeout, rate limit,
 * refusal, schema violation). The failure is always logged with its reason and surfaced
 * through `lastMode()` / `lastLabel()` so the status line shows which brain actually played
 * (W14: with the model, or with the failure class on a fallback bar, never the raw message).
 */
import type { Grid } from '../pattern';
import type { Addition, Brain, BrainContext, BrainMode } from './types';

export interface FallbackBrainOptions {
  primary: Brain | null;
  fallback: Brain;
  warn: (message: string) => void;
}

export interface FallbackBrain extends Brain {
  lastMode(): BrainMode;
  /** W14: "gemini gemini-3.8-flash", "rules (gemini timeout)" or "rules". */
  lastLabel(): string;
}

/**
 * W14: a short, fixed-vocabulary class for a brain failure, safe to show on the stage (a
 * provider message could quote a request; the class never does).
 */
export function failureClass(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/rate cap/i.test(message)) return 'rate cap';
  // Completers prefix HTTP errors with the provider ("gemini 429: …"); the Anthropic SDK starts with the status.
  const http = /^(?:gemini |openai |anthropic )?([45]\d\d)\b/i.exec(message);
  if (http?.[1]) {
    // W14 (coordinator): a permanent error says why the LLM is out, in words the host can act on.
    if (http[1] === '404') return 'unavailable: model not found';
    if (http[1] === '401' || http[1] === '403') return 'unavailable: no access';
    if (http[1] === '400') return /api key not valid|api_key_invalid/i.test(message) ? 'unavailable: invalid key' : 'unavailable: bad request';
    return `http ${http[1]}`;
  }
  if (/request failed/i.test(message)) return 'network';
  if (/model refused/i.test(message)) return 'refusal';
  if (/schema|parse|incomplete|no output text|non-JSON/i.test(message)) return 'bad output';
  return 'error';
}

function labelOf(brain: Brain): string {
  return brain.model ? `${brain.mode} ${brain.model}` : brain.mode;
}

export function createFallbackBrain(options: FallbackBrainOptions): FallbackBrain {
  const { primary, fallback, warn } = options;
  let last: BrainMode = primary ? primary.mode : fallback.mode;
  let label = labelOf(primary ?? fallback);
  return {
    mode: primary ? primary.mode : fallback.mode,
    ...(primary?.model ? { model: primary.model } : {}),
    lastMode: () => last,
    lastLabel: () => label,
    async plan(grid: Grid, ctx: BrainContext): Promise<Addition[]> {
      if (primary) {
        try {
          const out = await primary.plan(grid, ctx);
          last = primary.mode;
          label = labelOf(primary);
          return out;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          warn(`brain: ${primary.mode} failed (${reason}); using ${fallback.mode} for this bar`);
          last = fallback.mode;
          label = `${fallback.mode} (${primary.mode} ${failureClass(error)})`;
          return fallback.plan(grid, ctx);
        }
      }
      last = fallback.mode;
      label = labelOf(fallback);
      return fallback.plan(grid, ctx);
    },
  };
}
