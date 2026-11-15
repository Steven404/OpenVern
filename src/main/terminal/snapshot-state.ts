// What @xterm/addon-serialize leaves out of a snapshot and a replay needs (docs/terminal-plan.md §2, "Replay
// fidelity"): the scroll region (DECSTBM), the saved cursor (DECSC) and, because it homes the cursor, the cursor
// position under origin mode (DECOM); and, while the alternate screen is up, the pen the normal screen saved when it
// was entered. `withReplayState` adds them to the serializer's output, so that a fresh xterm that replays it ends in
// the same state for later output. Most snapshots need none of it and are returned unchanged.
//
// Known gaps, all rare: the normal buffer's scroll region is not restored while the alternate screen is up, nor its
// saved position when the program entered it with `?47h`/`?1047h` (which save nothing) rather than `?1049h`; the
// character set designations (`ESC ( 0`) are not restored; and saved and reprinted attributes keep colours and flags
// but not the underline style or colour.

import type { Terminal } from '@xterm/headless';
import { type AttributesLike, readScreenInternals } from './xterm-internals';

// xterm's colour modes (Attributes.CM_* in its buffer/Constants.ts), as returned by getFgColorMode().
const CM_P16 = 0x1000000;
const CM_P256 = 0x2000000;
const CM_RGB = 0x3000000;

function colorParams(mode: number, color: number, base: 30 | 40): string[] {
  if (mode === CM_P16) return [String(color < 8 ? base + color : base + 60 + (color - 8))];
  if (mode === CM_P256) return [String(base + 8), '5', String(color)];
  if (mode === CM_RGB) {
    return [String(base + 8), '2', String((color >> 16) & 0xff), String((color >> 8) & 0xff), String(color & 0xff)];
  }
  return [];
}

/** An SGR sequence that sets exactly these attributes, starting from a reset. */
export function sgrFor(attributes: AttributesLike): string {
  const params = ['0'];
  if (attributes.isBold()) params.push('1');
  if (attributes.isDim()) params.push('2');
  if (attributes.isItalic()) params.push('3');
  if (attributes.isUnderline()) params.push('4');
  if (attributes.isBlink()) params.push('5');
  if (attributes.isInverse()) params.push('7');
  if (attributes.isInvisible()) params.push('8');
  if (attributes.isStrikethrough()) params.push('9');
  if (attributes.isOverline()) params.push('53');
  params.push(...colorParams(attributes.getFgColorMode(), attributes.getFgColor(), 30));
  params.push(...colorParams(attributes.getBgColorMode(), attributes.getBgColor(), 40));
  return `\u001b[${params.join(';')}m`;
}

function isDefault(attributes: AttributesLike): boolean {
  return sgrFor(attributes) === '\u001b[0m';
}

const cup = (row: number, col: number) => `\u001b[${row + 1};${col + 1}H`;

/**
 * Moves the cursor to (x, y), y counted from `top` (the region's top under origin mode, else 0). x === cols is the
 * pending-wrap position after a character was printed in the last column; no cursor sequence reaches it (xterm clamps
 * even DECRC), so the last cell is printed again with its own attributes.
 */
function placeCursor(term: Terminal, x: number, y: number, top: number): string {
  const { cols } = term;
  if (x < cols) return cup(y - top, x);
  const buffer = term.buffer.active;
  const line = buffer.getLine(buffer.baseY + y);
  let col = cols - 1;
  let cell = line?.getCell(col);
  if (cell && cell.getWidth() === 0 && col > 0) {
    // The second half of a wide character: print the character from its first cell.
    col -= 1;
    cell = line?.getCell(col);
  }
  if (!cell) return cup(y - top, cols - 1);
  return `${cup(y - top, col)}${sgrFor(cell)}${cell.getChars() || ' '}`;
}

// The serializer's own entry to the alternate screen (SerializeAddon.serialize in @xterm/addon-serialize 0.14).
const ALT_SCREEN_ENTRY = '\u001b[?1049h\u001b[H';

/**
 * `serialized` (the serializer's output for `term`) with the replay state added. While the alternate screen is up,
 * the serializer enters it with the pen of the moment, so `?1049h` would save that pen for the normal screen; it is
 * entered with the pen the normal screen really saved instead, and the alternate content then starts from a reset
 * pen, which is what the serializer assumes when it writes it.
 */
export function withReplayState(serialized: string, term: Terminal): string {
  let out = serialized;
  if (term.buffer.active.type === 'alternate') {
    const at = out.indexOf(ALT_SCREEN_ENTRY);
    if (at < 0) throw new Error('snapshot: the serializer did not enter the alternate screen as expected');
    const normalSaved = sgrFor(readScreenInternals(term).normalSavedAttributes);
    out = `${out.slice(0, at)}${normalSaved}\u001b[?1049h\u001b[0m\u001b[H${out.slice(at + ALT_SCREEN_ENTRY.length)}`;
  }
  return out + replayStateSuffix(term);
}

/** Escape sequences that restore the region, the saved cursor and origin mode after a serialized snapshot. */
export function replayStateSuffix(term: Terminal): string {
  const internals = readScreenInternals(term);
  const { cols, rows } = term;
  const buffer = term.buffer.active;
  const { originMode, insertMode } = term.modes;
  const regionSet = internals.scrollTop !== 0 || internals.scrollBottom !== rows - 1;
  const savedSet = internals.savedX !== 0 || internals.savedY !== 0 || !isDefault(internals.savedAttributes);
  if (!regionSet && !savedSet && !originMode) return '';

  let out = '';
  // Absolute addressing and no insert while we move around and possibly print; both come back at the end.
  if (originMode) out += '\u001b[?6l';
  if (insertMode) out += '\u001b[4l';
  if (regionSet) out += `\u001b[${internals.scrollTop + 1};${internals.scrollBottom + 1}r`;
  if (savedSet) {
    // DECSC stores `ybase + y`; the replay has the same scrollback, so the same viewport row gives the same line.
    const row = Math.min(rows - 1, Math.max(0, internals.savedY - buffer.baseY));
    out += `${cup(row, Math.min(internals.savedX, cols - 1))}${sgrFor(internals.savedAttributes)}\u001b7`;
  }
  // Setting origin mode homes the cursor, so it goes before the final cursor position.
  if (originMode) out += '\u001b[?6h';
  out += placeCursor(term, buffer.cursorX, buffer.cursorY, originMode ? internals.scrollTop : 0);
  if (insertMode) out += '\u001b[4h';
  out += sgrFor(internals.currentAttributes);
  return out;
}
