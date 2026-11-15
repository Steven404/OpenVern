// The one place an xterm instance is built. Kept apart from `use-terminal.ts` so tests can mock the terminal itself
// (jsdom has no canvas, and xterm's DOM renderer needs measurements only a real browser has).

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL } from '@shared/terminal';
import { terminalTheme } from './xterm-theme';

/** JetBrains Mono at the `DESIGN.md` code size, on a 20 px line (plan §5). */
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
export const TERMINAL_FONT_SIZE = 12.5;
export const TERMINAL_LINE_HEIGHT = 1.6;

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false;

/** A DOM-renderer terminal with the dock's font, colours and scrollback. The caller owns `dispose()`. */
export function createTerminal(): Terminal {
  return new Terminal({
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    theme: terminalTheme(),
    scrollback: TERMINAL.scrollbackLines,
    cursorStyle: 'bar',
    cursorBlink: !reducedMotion(),
    allowProposedApi: false,
  });
}

export function createFitAddon(): FitAddon {
  return new FitAddon();
}
