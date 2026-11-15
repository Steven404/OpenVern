import { TERMINAL } from '@shared/terminal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTerminal,
  dockShowsMinimumRows,
  TERMINAL_DOCK_HEADER_HEIGHT,
  TERMINAL_DOCK_PADDING,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_ROW_HEIGHT,
  waitForTerminalFont,
} from './xterm';

describe('terminal metrics', () => {
  it('uses JetBrains Mono at 12.5 px on a 20 px row', () => {
    const term = createTerminal();
    try {
      expect(term.options.fontSize).toBe(TERMINAL_FONT_SIZE);
      expect(TERMINAL_FONT_SIZE).toBe(12.5);
      // xterm multiplies the measured cell height (about 17 px here), not the font size, by lineHeight. 1.6 gave
      // ~27 px rows; ~1.2 gives the 20 px row the design asks for.
      expect(term.options.lineHeight).toBe(TERMINAL_LINE_HEIGHT);
      expect(TERMINAL_LINE_HEIGHT).toBeGreaterThanOrEqual(1.15);
      expect(TERMINAL_LINE_HEIGHT).toBeLessThanOrEqual(1.25);
      expect(TERMINAL_ROW_HEIGHT).toBe(20);
      expect(term.options.scrollback).toBe(TERMINAL.scrollbackLines);
    } finally {
      term.dispose();
    }
  });

  it('the dock at dockMinHeight still fits TERMINAL.minRows full rows', () => {
    const screen = TERMINAL.dockMinHeight - TERMINAL_DOCK_HEADER_HEIGHT - TERMINAL_DOCK_PADDING * 2;
    expect(screen).toBeGreaterThanOrEqual(TERMINAL.minRows * TERMINAL_ROW_HEIGHT);
    expect(dockShowsMinimumRows()).toBe(true);
  });
});

describe('waitForTerminalFont', () => {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts');

  afterEach(() => {
    if (original) Object.defineProperty(document, 'fonts', original);
    else Reflect.deleteProperty(document, 'fonts');
    vi.useRealTimers();
  });

  function stubFonts(load: (font: string) => Promise<unknown>) {
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } });
  }

  it('returns at once when the FontFaceSet API is missing', async () => {
    Reflect.deleteProperty(document, 'fonts');
    await expect(waitForTerminalFont(5)).resolves.toBeUndefined();
  });

  it('resolves when the font loads', async () => {
    const load = vi.fn(async () => []);
    stubFonts(load);
    await waitForTerminalFont(50);
    expect(load).toHaveBeenCalledWith(`${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FAMILY}`);
  });

  it('does not block the dock when the font never loads', async () => {
    stubFonts(() => new Promise(() => {}));
    const started = Date.now();
    await waitForTerminalFont(20);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('swallows a font load failure', async () => {
    stubFonts(async () => {
      throw new Error('no font');
    });
    await expect(waitForTerminalFont(50)).resolves.toBeUndefined();
  });
});
