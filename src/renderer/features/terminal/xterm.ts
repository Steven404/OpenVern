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
/**
 * xterm multiplies the measured cell height (about 17 px at this size), not the font size, by `lineHeight`.
 * 1.6 gave ~27 px rows; 1.2 gives the 20 px row the design asks for.
 */
export const TERMINAL_LINE_HEIGHT = 1.2;
/** The laid-out row height, used to check that the dock's minimum height still fits `TERMINAL.minRows`. */
export const TERMINAL_ROW_HEIGHT = 20;
/** The dock header (`h-8`) and the space around the screen, in px. */
export const TERMINAL_DOCK_HEADER_HEIGHT = 32;
export const TERMINAL_DOCK_PADDING = 8;

/**
 * How long `useTerminal` waits for the mono font before measuring. A font that fails or is slow must not keep the dock
 * blank: measuring with the fallback is recoverable, and every later fit uses the loaded font.
 */
export const TERMINAL_FONT_LOAD_TIMEOUT_MS = 1_200;

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

/**
 * Resolves once JetBrains Mono can be measured, or after `timeoutMs` when it is missing, blocked or slow. The
 * FontFaceSet API is absent in jsdom, and guarded here so a test never waits.
 */
export async function waitForTerminalFont(timeoutMs = TERMINAL_FONT_LOAD_TIMEOUT_MS): Promise<void> {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fonts.load(`${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FAMILY}`).then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the dock's minimum height leaves room for `TERMINAL.minRows` full rows below its header. */
export function dockShowsMinimumRows(): boolean {
  const screenHeight = TERMINAL.dockMinHeight - TERMINAL_DOCK_HEADER_HEIGHT - TERMINAL_DOCK_PADDING * 2;
  return screenHeight >= TERMINAL.minRows * TERMINAL_ROW_HEIGHT;
}
