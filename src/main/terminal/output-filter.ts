// What PTY output becomes before it reaches the headless screen and the renderer (docs/terminal-plan.md §2, "Replay
// fidelity" and "Limits"). Two jobs, done in one pass over the stream:
//
// 1. Output events end only where the escape-sequence parser is at rest. A chunk that ends inside a sequence
//    (`ESC[31` waiting for its `m`) is cut before the sequence starts, and that tail is held back until the sequence
//    completes. Every data event, and so every `seq` boundary and every snapshot, then falls where xterm is in its
//    ground state, and a snapshot replayed into a fresh xterm parses later output the same way the original does.
//    The scanner below mirrors xterm 6's own transition table (`VT500_TRANSITION_TABLE` in its
//    EscapeSequenceParser), including the 8-bit C1 controls, which xterm parses as code points. A sequence that never
//    ends cannot hold output forever: past `HOLD_MAX_CHARS` the tail is let through as it is.
//
// 2. Runs of zero-width code points are capped. xterm joins a zero-width code point (a combining mark, ZWJ, a
//    variation selector, …) into the cell before the cursor, with no limit, so one cell could otherwise hold megabytes.
//    xterm only joins when the code point directly follows a printed one, with no control or escape in between, so a
//    joined run always lies inside a run of consecutive printed zero-width candidates. Capping those runs at
//    `COMBINING_RUN_MAX` bounds every cell at one base plus `COMBINING_RUN_MAX` code points: at most
//    2 * (COMBINING_RUN_MAX + 1) = 34 UTF-16 units. The cap holds across chunk boundaries (the run count is state).
//    `isZeroWidthCandidate` is a superset of what xterm 6 treats as zero-width (checked code point by code point in
//    output-filter.test.ts), so a code point xterm would join is never missed; a candidate xterm prints in a cell of
//    its own only makes the cap stricter.

/** Longest run of zero-width candidates kept; the rest of the run is dropped. */
export const COMBINING_RUN_MAX = 16;

/** Longest incomplete trailing sequence held back before it is let through anyway (UTF-16 units). */
export const HOLD_MAX_CHARS = 1024 * 1024;

// xterm's parser states (ParserState in xterm's parser/Constants.ts).
export const ParserState = {
  GROUND: 0,
  ESCAPE: 1,
  ESCAPE_INTERMEDIATE: 2,
  CSI_ENTRY: 3,
  CSI_PARAM: 4,
  CSI_INTERMEDIATE: 5,
  CSI_IGNORE: 6,
  SOS_PM_APC_STRING: 7,
  OSC_STRING: 8,
  DCS_ENTRY: 9,
  DCS_PARAM: 10,
  DCS_IGNORE: 11,
  DCS_INTERMEDIATE: 12,
  DCS_PASSTHROUGH: 13,
} as const;
export type ParserState = (typeof ParserState)[keyof typeof ParserState];

const STATE_COUNT = 14;
/** xterm looks up every code point from 0xA0 up under this one class. */
const NON_ASCII = 0xa0;
const CLASSES = NON_ASCII + 1;

/** Next state for (state, code class). Built the way xterm builds its table; only the states matter here. */
const TRANSITIONS: Uint8Array = (() => {
  const table = new Uint8Array(STATE_COUNT * CLASSES); // default: every unlisted pair goes to GROUND (xterm's ERROR)
  const set = (codes: Iterable<number>, state: ParserState, next: ParserState) => {
    for (const code of codes) table[state * CLASSES + code] = next;
  };
  const range = (start: number, end: number): number[] => Array.from({ length: end - start }, (_, i) => start + i);
  const S = ParserState;
  const PRINTABLES = range(0x20, 0x7f);
  const EXECUTABLES = [...range(0x00, 0x18), 0x19, ...range(0x1c, 0x20)];
  const all = range(S.GROUND, S.DCS_PASSTHROUGH + 1) as ParserState[];

  set(PRINTABLES, S.GROUND, S.GROUND);
  for (const state of all) {
    set([0x18, 0x1a, 0x99, 0x9a], state, S.GROUND);
    set(range(0x80, 0x98), state, S.GROUND);
    set([0x9c], state, S.GROUND);
    set([0x1b], state, S.ESCAPE);
    set([0x9d], state, S.OSC_STRING);
    set([0x98, 0x9e, 0x9f], state, S.SOS_PM_APC_STRING);
    set([0x9b], state, S.CSI_ENTRY);
    set([0x90], state, S.DCS_ENTRY);
  }
  set(EXECUTABLES, S.GROUND, S.GROUND);
  set(EXECUTABLES, S.ESCAPE, S.ESCAPE);
  set([0x7f], S.ESCAPE, S.ESCAPE);
  set(EXECUTABLES, S.OSC_STRING, S.OSC_STRING);
  set(EXECUTABLES, S.CSI_ENTRY, S.CSI_ENTRY);
  set([0x7f], S.CSI_ENTRY, S.CSI_ENTRY);
  set(EXECUTABLES, S.CSI_PARAM, S.CSI_PARAM);
  set([0x7f], S.CSI_PARAM, S.CSI_PARAM);
  set(EXECUTABLES, S.CSI_IGNORE, S.CSI_IGNORE);
  set(EXECUTABLES, S.CSI_INTERMEDIATE, S.CSI_INTERMEDIATE);
  set([0x7f], S.CSI_INTERMEDIATE, S.CSI_INTERMEDIATE);
  set(EXECUTABLES, S.ESCAPE_INTERMEDIATE, S.ESCAPE_INTERMEDIATE);
  set([0x7f], S.ESCAPE_INTERMEDIATE, S.ESCAPE_INTERMEDIATE);
  // OSC
  set([0x5d], S.ESCAPE, S.OSC_STRING);
  set(PRINTABLES, S.OSC_STRING, S.OSC_STRING);
  set([0x7f], S.OSC_STRING, S.OSC_STRING);
  set([0x9c, 0x18, 0x1a, 0x07], S.OSC_STRING, S.GROUND);
  set([0x1b], S.OSC_STRING, S.ESCAPE); // OSC_END, then xterm continues in ESCAPE (`ESC \` is the usual ST)
  set(range(0x1c, 0x20), S.OSC_STRING, S.OSC_STRING);
  // SOS, PM, APC
  set([0x58, 0x5e, 0x5f], S.ESCAPE, S.SOS_PM_APC_STRING);
  set(PRINTABLES, S.SOS_PM_APC_STRING, S.SOS_PM_APC_STRING);
  set(EXECUTABLES, S.SOS_PM_APC_STRING, S.SOS_PM_APC_STRING);
  set([0x9c], S.SOS_PM_APC_STRING, S.GROUND);
  set([0x7f], S.SOS_PM_APC_STRING, S.SOS_PM_APC_STRING);
  // CSI
  set([0x5b], S.ESCAPE, S.CSI_ENTRY);
  set(range(0x40, 0x7f), S.CSI_ENTRY, S.GROUND);
  set(range(0x30, 0x3c), S.CSI_ENTRY, S.CSI_PARAM);
  set([0x3c, 0x3d, 0x3e, 0x3f], S.CSI_ENTRY, S.CSI_PARAM);
  set(range(0x30, 0x3c), S.CSI_PARAM, S.CSI_PARAM);
  set(range(0x40, 0x7f), S.CSI_PARAM, S.GROUND);
  set([0x3c, 0x3d, 0x3e, 0x3f], S.CSI_PARAM, S.CSI_IGNORE);
  set(range(0x20, 0x40), S.CSI_IGNORE, S.CSI_IGNORE);
  set([0x7f], S.CSI_IGNORE, S.CSI_IGNORE);
  set(range(0x40, 0x7f), S.CSI_IGNORE, S.GROUND);
  set(range(0x20, 0x30), S.CSI_ENTRY, S.CSI_INTERMEDIATE);
  set(range(0x20, 0x30), S.CSI_INTERMEDIATE, S.CSI_INTERMEDIATE);
  set(range(0x30, 0x40), S.CSI_INTERMEDIATE, S.CSI_IGNORE);
  set(range(0x40, 0x7f), S.CSI_INTERMEDIATE, S.GROUND);
  set(range(0x20, 0x30), S.CSI_PARAM, S.CSI_INTERMEDIATE);
  // ESC intermediates and dispatch
  set(range(0x20, 0x30), S.ESCAPE, S.ESCAPE_INTERMEDIATE);
  set(range(0x20, 0x30), S.ESCAPE_INTERMEDIATE, S.ESCAPE_INTERMEDIATE);
  set(range(0x30, 0x7f), S.ESCAPE_INTERMEDIATE, S.GROUND);
  set(range(0x30, 0x50), S.ESCAPE, S.GROUND);
  set(range(0x51, 0x58), S.ESCAPE, S.GROUND);
  set([0x59, 0x5a, 0x5c], S.ESCAPE, S.GROUND);
  set(range(0x60, 0x7f), S.ESCAPE, S.GROUND);
  // DCS
  set([0x50], S.ESCAPE, S.DCS_ENTRY);
  set(EXECUTABLES, S.DCS_ENTRY, S.DCS_ENTRY);
  set([0x7f], S.DCS_ENTRY, S.DCS_ENTRY);
  set(range(0x1c, 0x20), S.DCS_ENTRY, S.DCS_ENTRY);
  set(range(0x20, 0x30), S.DCS_ENTRY, S.DCS_INTERMEDIATE);
  set(range(0x30, 0x3c), S.DCS_ENTRY, S.DCS_PARAM);
  set([0x3c, 0x3d, 0x3e, 0x3f], S.DCS_ENTRY, S.DCS_PARAM);
  set(EXECUTABLES, S.DCS_IGNORE, S.DCS_IGNORE);
  set(range(0x20, 0x80), S.DCS_IGNORE, S.DCS_IGNORE);
  set(range(0x1c, 0x20), S.DCS_IGNORE, S.DCS_IGNORE);
  set(EXECUTABLES, S.DCS_PARAM, S.DCS_PARAM);
  set([0x7f], S.DCS_PARAM, S.DCS_PARAM);
  set(range(0x1c, 0x20), S.DCS_PARAM, S.DCS_PARAM);
  set(range(0x30, 0x3c), S.DCS_PARAM, S.DCS_PARAM);
  set([0x3c, 0x3d, 0x3e, 0x3f], S.DCS_PARAM, S.DCS_IGNORE);
  set(range(0x20, 0x30), S.DCS_PARAM, S.DCS_INTERMEDIATE);
  set(EXECUTABLES, S.DCS_INTERMEDIATE, S.DCS_INTERMEDIATE);
  set([0x7f], S.DCS_INTERMEDIATE, S.DCS_INTERMEDIATE);
  set(range(0x1c, 0x20), S.DCS_INTERMEDIATE, S.DCS_INTERMEDIATE);
  set(range(0x20, 0x30), S.DCS_INTERMEDIATE, S.DCS_INTERMEDIATE);
  set(range(0x30, 0x40), S.DCS_INTERMEDIATE, S.DCS_IGNORE);
  set(range(0x40, 0x7f), S.DCS_INTERMEDIATE, S.DCS_PASSTHROUGH);
  set(range(0x40, 0x7f), S.DCS_PARAM, S.DCS_PASSTHROUGH);
  set(range(0x40, 0x7f), S.DCS_ENTRY, S.DCS_PASSTHROUGH);
  set(EXECUTABLES, S.DCS_PASSTHROUGH, S.DCS_PASSTHROUGH);
  set(PRINTABLES, S.DCS_PASSTHROUGH, S.DCS_PASSTHROUGH);
  set([0x7f], S.DCS_PASSTHROUGH, S.DCS_PASSTHROUGH);
  set([0x9c, 0x18, 0x1a], S.DCS_PASSTHROUGH, S.GROUND);
  set([0x1b], S.DCS_PASSTHROUGH, S.ESCAPE); // DCS_UNHOOK, then ESCAPE
  // Code points from 0xA0 up
  set([NON_ASCII], S.GROUND, S.GROUND);
  set([NON_ASCII], S.OSC_STRING, S.OSC_STRING);
  set([NON_ASCII], S.CSI_IGNORE, S.CSI_IGNORE);
  set([NON_ASCII], S.DCS_IGNORE, S.DCS_IGNORE);
  set([NON_ASCII], S.DCS_PASSTHROUGH, S.DCS_PASSTHROUGH);
  return table;
})();

/** The parser state after `code` in `state`, as xterm 6 computes it. */
export function nextParserState(state: ParserState, code: number): ParserState {
  return TRANSITIONS[state * CLASSES + Math.min(code, NON_ASCII)] as ParserState;
}

/** Whether xterm prints `code` when it arrives in `state` (printable ASCII or anything from 0xA0, in ground). */
function isPrinted(state: ParserState, code: number): boolean {
  return state === ParserState.GROUND && ((code >= 0x20 && code < 0x7f) || code >= NON_ASCII);
}

// Combining marks, format characters, default-ignorables, and the Hangul medial vowels and final consonants
// (U+1160–U+11FF), which xterm's Unicode 6 table also gives no width, and U+06DE, a mark in Unicode 6 but not now.
const ZERO_WIDTH_RE = /^[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}\u{1160}-\u{11FF}\u{06DE}]$/u;
const BMP_ZERO_WIDTH: Uint8Array = (() => {
  const table = new Uint8Array(0x10000);
  for (let code = 0xa0; code < 0x10000; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (ZERO_WIDTH_RE.test(String.fromCharCode(code))) table[code] = 1;
  }
  return table;
})();

/** A code point xterm may give no width (and so join into the previous cell). A superset of xterm 6's own set. */
export function isZeroWidthCandidate(code: number): boolean {
  if (code < 0xa0) return false;
  if (code < 0x10000) return BMP_ZERO_WIDTH[code] === 1;
  return ZERO_WIDTH_RE.test(String.fromCodePoint(code));
}

export interface OutputFilterOptions {
  combiningRunMax?: number;
  holdMaxChars?: number;
}

/** Per-session stream state. `push` returns what may be emitted now; `flush` returns whatever is still held. */
export class OutputFilter {
  private state: ParserState = ParserState.GROUND;
  /** Consecutive printed zero-width candidates since the last other code point. */
  private run = 0;
  /** Output already filtered but not yet emitted: an incomplete sequence, or a lone high surrogate, at the end. */
  private held = '';
  /** A high surrogate that ended the previous chunk, waiting for its low half. */
  private highSurrogate = '';
  private readonly runMax: number;
  private readonly holdMax: number;

  constructor(options: OutputFilterOptions = {}) {
    this.runMax = options.combiningRunMax ?? COMBINING_RUN_MAX;
    this.holdMax = options.holdMaxChars ?? HOLD_MAX_CHARS;
  }

  /** True when nothing is held and the parser is in its ground state. */
  get atRest(): boolean {
    return this.state === ParserState.GROUND && this.held === '' && this.highSurrogate === '';
  }

  /** The parser state after everything pushed so far (for tests). */
  get parserState(): ParserState {
    return this.state;
  }

  push(chunk: string): string {
    const data = this.highSurrogate + chunk;
    this.highSurrogate = '';
    const parts: string[] = [this.held];
    let out = this.held.length; // length of everything in `parts`
    // Length of the longest prefix of the output that ends with the parser at rest. What is held is never at rest.
    let restAt = this.held === '' ? 0 : -1;
    let copyFrom = 0;
    let i = 0;
    while (i < data.length) {
      let code = data.charCodeAt(i);
      let size = 1;
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 >= data.length) {
          // Wait for the low half rather than splitting the code point.
          parts.push(data.slice(copyFrom, i));
          out += i - copyFrom;
          this.highSurrogate = data.slice(i);
          copyFrom = data.length;
          break;
        }
        const low = data.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
          size = 2;
        }
      }
      if (isPrinted(this.state, code) && isZeroWidthCandidate(code)) {
        if (this.run >= this.runMax) {
          // Drop it: copy what came before, skip this code point.
          parts.push(data.slice(copyFrom, i));
          out += i - copyFrom;
          copyFrom = i + size;
        } else {
          this.run += 1;
        }
      } else {
        this.run = 0;
      }
      this.state = nextParserState(this.state, code);
      i += size;
      if (this.state === ParserState.GROUND) restAt = out + (i - copyFrom);
    }
    if (copyFrom < data.length) {
      parts.push(data.slice(copyFrom));
      out += data.length - copyFrom;
    }
    const all = parts.join('');
    if (restAt < 0) restAt = 0;
    if (all.length - restAt > this.holdMax) restAt = all.length;
    this.held = all.slice(restAt);
    return all.slice(0, restAt);
  }

  /** Everything still held, for the end of the stream (the shell exited). Leaves the parser state as it is. */
  flush(): string {
    const rest = this.held + this.highSurrogate;
    this.held = '';
    this.highSurrogate = '';
    return rest;
  }
}
