// xterm colours for the dock (terminal plan §5), derived from the Blue hour tokens in `styles/tokens.css` so no colour
// is invented here.
//
// The tokens are read from the document at creation time, so a future theme is picked up without a second palette.
// xterm only parses `#rrggbb`, `#rgb`, `#rrggbbaa` and comma-separated `rgb()` / `rgba()`, so every value handed to it
// is one of those; the two hues with no token of their own (magenta and cyan) are mixes of tokens, and the bright ANSI
// variants are their normal colour mixed toward `text`.

import type { ITheme } from '@xterm/xterm';

/** The Blue hour values, for tests and before the stylesheet has applied. Mirrors `styles/tokens.css`. */
const FALLBACK = {
  '--color-code': '#0a0d1c',
  '--color-bg': '#10162e',
  '--color-text': '#ecf0fa',
  '--color-text-body': '#d8deef',
  '--color-text-muted': '#9ba5c6',
  '--color-text-faint': '#8792b6',
  '--color-accent': '#f6bd60',
  '--color-accent-2': '#e5865f',
  '--color-success': '#9fd4b3',
  '--color-danger': '#ff8f87',
  '--color-diff-range': '#a9b8f0',
  '--color-selection-text': '#fff4e0',
  '--color-border-control': '#343f72',
  '--color-border-hover': '#46528c',
  '--color-border-focus': '#5a68a8',
} as const;

type Token = keyof typeof FALLBACK;

/** Reads a `--color-*` custom property from the document root, falling back to the Blue hour value. */
export function readColorToken(name: Token): string {
  const fallback = FALLBACK[name];
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

type Rgb = [number, number, number];

/** `#rgb`, `#rrggbb` or `rgb(r, g, b)` → channels. `null` for anything else. */
function toRgb(color: string): Rgb | null {
  const value = color.trim();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return [1, 2, 3].map((i) => Number.parseInt(value.slice(i, i + 1).repeat(2), 16)) as Rgb;
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as Rgb;
  }
  const match = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
  return null;
}

/** `a` mixed `t` (0…1) of the way toward `b`. Unparseable input returns `b`. */
export function mixColor(a: string, b: string, t: number): string {
  const from = toRgb(a);
  const to = toRgb(b);
  if (!from || !to) return b;
  const [r1, g1, b1] = from;
  const [r2, g2, b2] = to;
  const channel = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${channel(r1, r2)}, ${channel(g1, g2)}, ${channel(b1, b2)})`;
}

/** The theme accent at a fixed alpha, in the comma form xterm parses. */
function translucent(color: string, alpha: number): string {
  const rgb = toRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

export function terminalTheme(): ITheme {
  const token = readColorToken;
  const text = token('--color-text');
  const accent = token('--color-accent');
  const blue = token('--color-diff-range');
  const red = token('--color-danger');
  const green = token('--color-success');
  const yellow = accent;
  const magenta = mixColor(token('--color-accent-2'), blue, 0.55);
  const cyan = mixColor(green, blue, 0.5);
  const white = token('--color-text-muted');
  const bright = (color: string, t = 0.35) => mixColor(color, text, t);
  return {
    background: token('--color-code'),
    foreground: text,
    cursor: accent,
    cursorAccent: token('--color-bg'),
    selectionBackground: translucent(accent, 0.28),
    selectionForeground: token('--color-selection-text'),
    selectionInactiveBackground: translucent(accent, 0.16),
    scrollbarSliderBackground: translucent(token('--color-border-control'), 0.6),
    scrollbarSliderHoverBackground: translucent(token('--color-border-hover'), 0.8),
    scrollbarSliderActiveBackground: token('--color-border-focus'),
    black: token('--color-border-control'),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack: token('--color-text-faint'),
    brightRed: bright(red),
    brightGreen: bright(green),
    brightYellow: bright(yellow),
    brightBlue: bright(blue),
    brightMagenta: bright(magenta, 0.45),
    brightCyan: bright(cyan),
    brightWhite: token('--color-text'),
  };
}
