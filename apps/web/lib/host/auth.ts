/**
 * Presenter authentication for the session routes: a shared secret (`HOST_SECRET`) sent in
 * the `x-blockbeat-host` header. Compared in constant time over a digest so length and
 * content differences cannot be timed. The secret never appears in logs or responses.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const HOST_HEADER = 'x-blockbeat-host';

export function hostSecretFromEnv(env: Record<string, string | undefined>): string | null {
  const raw = env.HOST_SECRET?.trim();
  return raw ? raw : null;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** True only when a secret is configured and the header carries exactly that secret. */
export function isAuthorizedHost(headers: Headers, secret: string | null): boolean {
  if (secret === null) return false;
  const presented = headers.get(HOST_HEADER);
  if (presented === null || presented.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(secret));
}
