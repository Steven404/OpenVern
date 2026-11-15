// The only place that reads @xterm/headless internals (6.0.0). The public API has no way to read the scroll region,
// the saved cursor (DECSC) or the current pen, which a snapshot must restore (docs/terminal-plan.md §2, "Replay
// fidelity"); @xterm/addon-serialize reads the pen the same way. Every read checks the shape first and throws
// `XtermInternalsError` when it has changed, so an incompatible upgrade fails loudly (xterm-internals.test.ts) rather
// than replaying a wrong screen. Test-only helpers are at the bottom.

import type { Terminal } from '@xterm/headless';

export class XtermInternalsError extends Error {
  constructor(what: string) {
    super(
      `@xterm/headless internals changed: ${what}. Check src/main/terminal/xterm-internals.ts against the new version.`,
    );
    this.name = 'XtermInternalsError';
  }
}

/** The methods of xterm's AttributeData (and of a public IBufferCell) that an SGR sequence is rebuilt from. */
export interface AttributesLike {
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  getFgColorMode(): number;
  getBgColorMode(): number;
  getFgColor(): number;
  getBgColor(): number;
}

export interface ScreenInternals {
  /** Scroll region of the active buffer, 0-based and inclusive. */
  scrollTop: number;
  scrollBottom: number;
  /** Saved cursor of the active buffer: `savedY` is an absolute buffer line (`ybase + y` when it was saved). */
  savedX: number;
  savedY: number;
  savedAttributes: AttributesLike;
  /** The pen: what the next printed character gets. */
  currentAttributes: AttributesLike;
  /** The normal buffer's saved pen (what leaving the alternate screen with `?1049l` restores). */
  normalSavedAttributes: AttributesLike;
}

type Bag = Record<string, unknown>;

function field(object: unknown, name: string, what: string): unknown {
  if (typeof object !== 'object' || object === null || !(name in object)) throw new XtermInternalsError(`no ${what}`);
  return (object as Bag)[name];
}

function int(object: unknown, name: string, what: string): number {
  const value = field(object, name, what);
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new XtermInternalsError(`${what} is not an integer`);
  return value;
}

const ATTRIBUTE_METHODS: readonly (keyof AttributesLike)[] = [
  'isBold',
  'isDim',
  'isItalic',
  'isUnderline',
  'isBlink',
  'isInverse',
  'isInvisible',
  'isStrikethrough',
  'isOverline',
  'getFgColorMode',
  'getBgColorMode',
  'getFgColor',
  'getBgColor',
];

function attributes(object: unknown, what: string): AttributesLike {
  if (typeof object !== 'object' || object === null) throw new XtermInternalsError(`no ${what}`);
  for (const method of ATTRIBUTE_METHODS) {
    if (typeof (object as Bag)[method] !== 'function') throw new XtermInternalsError(`${what} has no ${method}()`);
  }
  return object as AttributesLike;
}

function core(term: Terminal): unknown {
  return field(term, '_core', 'Terminal._core');
}

export function readScreenInternals(term: Terminal): ScreenInternals {
  const c = core(term);
  const buffer = field(c, 'buffer', '_core.buffer');
  const inputHandler = field(c, '_inputHandler', '_core._inputHandler');
  const normal = field(field(c, 'buffers', '_core.buffers'), 'normal', '_core.buffers.normal');
  return {
    scrollTop: int(buffer, 'scrollTop', 'buffer.scrollTop'),
    scrollBottom: int(buffer, 'scrollBottom', 'buffer.scrollBottom'),
    savedX: int(buffer, 'savedX', 'buffer.savedX'),
    savedY: int(buffer, 'savedY', 'buffer.savedY'),
    savedAttributes: attributes(field(buffer, 'savedCurAttrData', 'buffer.savedCurAttrData'), 'savedCurAttrData'),
    currentAttributes: attributes(
      field(inputHandler, '_curAttrData', '_inputHandler._curAttrData'),
      '_inputHandler._curAttrData',
    ),
    normalSavedAttributes: attributes(
      field(normal, 'savedCurAttrData', 'buffers.normal.savedCurAttrData'),
      'buffers.normal.savedCurAttrData',
    ),
  };
}

// Test-only: used by the replay and filter tests to compare against xterm itself.

/** xterm's parser state (ParserState) after everything written and parsed so far. */
export function readParserState(term: Terminal): number {
  const parser = field(field(core(term), '_inputHandler', '_core._inputHandler'), '_parser', '_inputHandler._parser');
  return int(parser, 'currentState', '_parser.currentState');
}

/** xterm's cell width for a code point under its active Unicode version. */
export function readWcwidth(term: Terminal): (code: number) => number {
  const service = field(core(term), 'unicodeService', '_core.unicodeService');
  const wcwidth = field(service, 'wcwidth', 'unicodeService.wcwidth');
  if (typeof wcwidth !== 'function') throw new XtermInternalsError('unicodeService.wcwidth is not a function');
  return (code) => (wcwidth as (code: number) => number).call(service, code);
}
