'use client';
/**
 * W21b: whether the stage shows its join code. Hidden (blurred) by default; the host bar's
 * "Show join code" flips it for this tab only (sessionStorage, so a reload keeps it and a new
 * projector tab starts hidden). Storage failures keep the choice in memory.
 */
import { useCallback, useSyncExternalStore } from 'react';

export const JOIN_QR_STORAGE_KEY = 'blockbeat:stage:join-qr:v1';

const listeners = new Set<() => void>();
let memory: boolean | null = null;

function read(): boolean {
  if (memory !== null) return memory;
  try {
    return window.sessionStorage.getItem(JOIN_QR_STORAGE_KEY) === 'shown';
  } catch {
    return false;
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function write(visible: boolean): void {
  memory = null;
  try {
    if (visible) window.sessionStorage.setItem(JOIN_QR_STORAGE_KEY, 'shown');
    else window.sessionStorage.removeItem(JOIN_QR_STORAGE_KEY);
  } catch (error) {
    memory = visible;
    console.warn(`stage: could not keep the join code choice (${error instanceof Error ? error.message : String(error)}); kept in memory`);
  }
  for (const cb of listeners) cb();
}

export function useJoinQrVisible(): [boolean, (visible: boolean) => void] {
  const visible = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => write(next), []);
  return [visible, set];
}
