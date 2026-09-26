'use client';
import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/** Browser origin, empty string during SSR and the first client render. */
export function useOrigin(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.origin,
    () => '',
  );
}
