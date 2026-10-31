import { useSyncExternalStore } from 'react';

/** Narrow-window breakpoint (D19). */
export const NARROW_QUERY = '(max-width: 760px)';

/** `matchMedia` subscription; `false` where `matchMedia` doesn't exist (jsdom). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
      mql?.addEventListener('change', onChange);
      return () => mql?.removeEventListener('change', onChange);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  );
}
