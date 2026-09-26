// W15: plain module (no 'use client') so the server stage page can call it.

/**
 * True when the stage URL carries `?host=1`. Read by the server page from `searchParams`, so
 * it is right on the first render, after a client-side navigation from /host too.
 */
export function hostBarRequested(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.includes('1') : value === '1';
}
