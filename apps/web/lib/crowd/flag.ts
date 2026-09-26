/**
 * The crowd simulator is off unless NEXT_PUBLIC_CROWD_ENABLED=1: the host bar hides its buttons
 * and panel, and POST /api/crowd/start answers 503 CROWD_DISABLED. The literal
 * `process.env.NEXT_PUBLIC_CROWD_ENABLED` default lets Next.js inline it in the client bundle.
 */
export function crowdEnabled(raw: string | undefined = process.env.NEXT_PUBLIC_CROWD_ENABLED): boolean {
  return raw?.trim() === '1';
}
