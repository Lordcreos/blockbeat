/** Tiny class-name joiner; avoids a dependency for the few conditional classes we need. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
