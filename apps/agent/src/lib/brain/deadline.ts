/**
 * W14 / W14b: helpers shared by the HTTP completers (Gemini, OpenAI): one deadline per call (an
 * AbortSignal), a pause that the deadline can cut short before the single 429 / 5xx retry, and
 * key redaction for any provider or transport message that might echo the key.
 */

/** Waits `ms`, or rejects with the signal's reason as soon as the deadline fires. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Drops the key if a message ever echoes it, and caps the length for a status line. */
export function redactKey(message: string, apiKey: string): string {
  return (apiKey ? message.split(apiKey).join('…') : message).slice(0, 200);
}

/**
 * True when the error is the deadline firing (our signal, or a fetch/SDK abort). Callers check their
 * typed HTTP / API errors first, so a real status that lands as the clock runs out keeps its class.
 */
export function isDeadline(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
}
