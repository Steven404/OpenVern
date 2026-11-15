// The authoritative screen of one session (docs/terminal-plan.md §2): a headless xterm that every byte of PTY output
// is written into. Reload replay (the serialized snapshot) and model reads both come from here.
//
// xterm parses writes asynchronously, so anything that looks at the buffer goes through `afterParsed`, which runs its
// callback once everything written so far has been parsed, and before anything written later.

import { TERMINAL, type TerminalReadRequest, type TerminalReadResult } from '@shared/terminal';
import { SerializeAddon } from '@xterm/addon-serialize/lib/addon-serialize.mjs';
import { Terminal } from '@xterm/headless';

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

  /** Screen, scrollback and modes as escape sequences, for a renderer xterm of the same size. Call via `afterParsed`. */
  serialize(): string {
    return this.serializer.serialize({ scrollback: TERMINAL.scrollbackLines });
  }

  /** The requested range per §4.1, from the active buffer (the screen the user sees). Call via `afterParsed`. */
  read(request: TerminalReadRequest): ScreenRead {
    return selectLines(this.logicalLines(), request);
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
 * Picks whole logical lines (1-based) per §4.1. Both omitted: the last `readDefaultLines`. Only `count`: the last
 * `count`. `startLine` set: from there, `count` (default `readDefaultLines`) lines, clamped to the end. `count` is
 * capped at `readMaxLines`. An empty buffer, or a `startLine` past `totalLines`, gives `startLine: 0, endLine: 0` and
 * no text.
 *
 * Never cut by bytes: a cut could drop a key's prefix and leave its body where no redaction pattern matches, so the
 * backend applies `readMaxBytes` after redacting. `truncated` is therefore always false here.
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
