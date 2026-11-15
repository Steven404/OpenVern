// The composer's textarea, found without a ref so a feature outside the composer can send focus back to it. The
// terminal dock does this when it hides (terminal plan §5).

export const COMPOSER_INPUT_SELECTOR = 'textarea[data-composer-input]';

/** Focuses the composer on screen. True when there was one. */
export function focusComposer(): boolean {
  const el = document.querySelector<HTMLElement>(COMPOSER_INPUT_SELECTOR);
  if (!el) return false;
  el.focus();
  return true;
}
