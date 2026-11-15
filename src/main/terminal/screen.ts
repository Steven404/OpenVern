// The authoritative screen of one session (docs/terminal-plan.md §2): a headless xterm that every byte of PTY output
// is written into. Reload replay (the serialized snapshot) and model reads both come from here.
//
// xterm parses writes asynchronously, so anything that looks at the buffer goes through `afterParsed`, which runs its
// callback once everything written so far has been parsed, and before anything written later.

import { redactSecrets } from '@shared/redact';
import { TERMINAL, type TerminalReadRequest, type TerminalReadResult } from '@shared/terminal';
import { SerializeAddon } from '@xterm/addon-serialize/lib/addon-serialize.mjs';
import { Terminal } from '@xterm/headless';
import { withReplayState } from './snapshot-state';

export type ScreenRead = Omit<TerminalReadResult, 'info'>;

export class ScreenDisposedError extends Error {
  constructor() {
    super('The terminal was closed.');
    this.name = 'ScreenDisposedError';
  }
}

export class TerminalScreen {
  private readonly term: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly waiters = new Set<(err: Error) => void>();
  private disposed = false;

  constructor(cols: number, rows: number, scrollback: number = TERMINAL.scrollbackLines) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.term.loadAddon(this.serializer);
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** Queues output for parsing. `parsed` runs once this chunk has been parsed. */
  write(data: string, parsed?: () => void): void {
    if (this.disposed) return;
    this.term.write(data, parsed);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || (cols === this.term.cols && rows === this.term.rows)) return;
    this.term.resize(cols, rows);
  }

  /**
   * Runs `fn` once everything written so far has been parsed (and nothing written afterwards has). Rejects with
   * `ScreenDisposedError` if the screen is disposed first.
   */
  afterParsed<T>(fn: () => T): Promise<T> {
    if (this.disposed) return Promise.reject(new ScreenDisposedError());
    return new Promise<T>((resolve, reject) => {
      const fail = (err: Error) => reject(err);
      this.waiters.add(fail);
      // An empty write still gets its callback, in order with the writes before it.
      this.term.write('', () => {
        if (!this.waiters.delete(fail)) return;
        try {
          resolve(fn());
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Screen, scrollback, modes, scroll region and saved cursor as escape sequences, for a fresh renderer xterm of the
   * same size. Call via `afterParsed`. Output reaches the screen only in pieces that end with the parser at rest
   * (./output-filter.ts), so the snapshot never starts a sequence the replay would finish differently.
   */
  serialize(): string {
    return withReplayState(this.serializer.serialize({ scrollback: TERMINAL.scrollbackLines }), this.term);
  }

  /**
   * The requested range per §4.1, from the active buffer (the screen the user sees), redacted and bounded by
   * `readWireMaxChars` (see `readLines`). Call via `afterParsed`.
   */
  read(request: TerminalReadRequest): ScreenRead {
    return readLines(this.logicalLines(), request);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const err = new ScreenDisposedError();
    for (const fail of this.waiters) fail(err);
    this.waiters.clear();
    this.term.dispose();
  }

  /** Buffer rows with wrapped continuations joined, trailing spaces trimmed and trailing blank lines dropped. */
  private logicalLines(): string[] {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    let current: string | null = null;
    for (let y = 0; y < buffer.length; y++) {
      const row = buffer.getLine(y);
      if (!row) continue;
      // Untrimmed, so a space that sits at a wrap point survives the join.
      const text = row.translateToString(false);
      if (row.isWrapped && current !== null) {
        current += text;
      } else {
        if (current !== null) lines.push(trimRight(current));
        current = text;
      }
    }
    if (current !== null) lines.push(trimRight(current));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
}

function trimRight(line: string): string {
  return line.replace(/ +$/, '');
}

/**
 * A read per §4.1, in the order that keeps secrets out: the pattern passes of `redactSecrets` run over the whole
 * buffer first (so a private-key block that starts above the range is still caught, and nothing has been cut yet),
 * then the range is selected, then `boundLines` fits it into `maxChars`. `redactSecrets` keeps the number of line
 * breaks, so line numbers are the same before and after.
 */
export function readLines(
  lines: readonly string[],
  request: TerminalReadRequest,
  maxChars: number = TERMINAL.readWireMaxChars,
): ScreenRead {
  const redacted = lines.length === 0 ? [] : redactSecrets(lines.join('\n')).text.split('\n');
  // Should never happen (see above); refuse rather than return lines under the wrong numbers.
  if (redacted.length !== lines.length) throw new Error('terminal read: redaction changed the line count');
  const selected = selectLines(redacted, request);
  if (selected.startLine === 0) return selected;
  return boundLines(redacted.slice(selected.startLine - 1, selected.endLine), selected, maxChars);
}

/** The one-line stand-in for a line longer than the whole answer may be. */
export function omittedLinePlaceholder(lineNumber: number, length: number): string {
  return `[line ${lineNumber} omitted: ${length} characters, more than one read can return]`;
}

/**
 * Fits whole lines into `maxChars` (joined with '\n'): a line longer than `maxChars` on its own becomes a placeholder,
 * then whole lines are dropped from the start of the range until the rest fits, and `startLine` moves to the first
 * line kept. `truncated` says either happened. Never a cut inside a line.
 */
function boundLines(range: readonly string[], selected: ScreenRead, maxChars: number): ScreenRead {
  let truncated = false;
  const kept = range.map((line, index) => {
    if (line.length <= maxChars) return line;
    truncated = true;
    return omittedLinePlaceholder(selected.startLine + index, line.length);
  });
  let first = 0;
  let size = kept.reduce((sum, line) => sum + line.length, 0) + kept.length - 1;
  // Keep at least the last line: on its own it fits (a placeholder is short).
  while (size > maxChars && first < kept.length - 1) {
    size -= (kept[first]?.length ?? 0) + 1;
    first += 1;
    truncated = true;
  }
  const startLine = selected.startLine + first;
  return { ...selected, startLine, text: kept.slice(first).join('\n'), truncated };
}

/**
 * Picks whole logical lines (1-based) per §4.1. Both omitted: the last `readDefaultLines`. Only `count`: the last
 * `count`. `startLine` set: from there, `count` (default `readDefaultLines`) lines, clamped to the end. `count` is
 * capped at `readMaxLines`. An empty buffer, or a `startLine` past `totalLines`, gives `startLine: 0, endLine: 0` and
 * no text. Not bounded by size: `readLines` does that, after redaction.
 */
export function selectLines(lines: readonly string[], request: TerminalReadRequest): ScreenRead {
  const totalLines = lines.length;
  const count = clampInt(request.count ?? TERMINAL.readDefaultLines, 1, TERMINAL.readMaxLines);
  const startLine =
    request.startLine === undefined ? Math.max(1, totalLines - count + 1) : Math.floor(request.startLine);
  if (totalLines === 0 || startLine < 1 || startLine > totalLines) {
    return { totalLines, startLine: 0, endLine: 0, text: '', truncated: false };
  }
  const endLine = Math.min(totalLines, startLine + count - 1);
  return { totalLines, startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n'), truncated: false };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
