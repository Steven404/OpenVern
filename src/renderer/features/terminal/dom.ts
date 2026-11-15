// DOM facts about the dock that the app-level shortcut handler needs. Kept apart from the components so `shortcuts.ts`
// does not pull xterm (and its stylesheet) into its module graph.

/** Marks the dock's root element (and so every element the terminal can focus). */
export const TERMINAL_DOCK_SELECTOR = '[data-terminal-dock]';

/**
 * True while focus is inside the terminal dock. Global shortcuts other than `Ctrl`+backtick then stay out of the way,
 * so the shell receives Ctrl+B, Ctrl+N and the rest (plan §5).
 */
export function isTerminalFocused(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): boolean {
  const active = doc?.activeElement;
  return active instanceof HTMLElement && active.closest(TERMINAL_DOCK_SELECTOR) !== null;
}
