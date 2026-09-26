/** Minimal timestamped logger. Never pass key material to it. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * W14 backstop: provider API key shapes (Google "AIza…", OpenAI / Anthropic "sk-…") are cut from
 * every line, so a provider error that ever echoes a key cannot reach the terminal or the stage
 * (the web keeps the DJ's last lines). The completers redact at the source too.
 */
const API_KEY_RES: ReadonlyArray<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…redacted'],
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-…redacted'],
];

export function redactSecrets(text: string): string {
  return API_KEY_RES.reduce((acc, [re, replacement]) => acc.replace(re, replacement), text);
}

export function createLogger(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const stamp = () => new Date().toISOString().slice(11, 23);
  return {
    info: (m) => write(`${stamp()} ${redactSecrets(m)}`),
    warn: (m) => write(`${stamp()} WARN ${redactSecrets(m)}`),
  };
}

/** The origin of an RPC url for logs (a provider key in the path or query is dropped); the raw text when it is not a URL. */
export function rpcOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '<invalid url>';
  }
}
