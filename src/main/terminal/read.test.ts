// The read contract (docs/terminal-plan.md §4.1, T1.4): logical lines, whole lines, no byte cap, nothing cut.
// Reads go through a real TerminalSession and a real headless xterm, driven by a fake PTY.

import { TERMINAL } from '@shared/terminal';
import { describe, expect, it } from 'vitest';
import { createFakePty, type FakePty } from './fake-pty';
import { TerminalScreen } from './screen';
import { TerminalSession } from './session';

function makeSession(): { session: TerminalSession; pty: FakePty } {
  const pty = createFakePty();
  const session = new TerminalSession({
    chatId: 'chat-read',
    pty,
    screen: new TerminalScreen(80, 24),
    shell: 'zsh',
    cwd: '/home/me',
    events: { data: () => {}, exit: () => {} },
  });
  return { session, pty };
}

/** `count` numbered lines, each ended by CRLF, as one chunk of shell output. */
function numberedLines(count: number): string {
  return `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\r\n')}\r\n`;
}

function textLines(text: string): string[] {
  return text.split('\n');
}

describe('read: default range and paging', () => {
  it('defaults to the last 200 logical lines', async () => {
    const { session, pty } = makeSession();
    pty.emitData(numberedLines(250));
    const result = await session.read({});

    expect(result).toMatchObject({ totalLines: 250, startLine: 51, endLine: 250, truncated: false });
    expect(textLines(result.text)).toHaveLength(TERMINAL.readDefaultLines);
    expect(textLines(result.text)[0]).toBe('line 51');
    expect(textLines(result.text).at(-1)).toBe('line 250');
    expect(result.info).toMatchObject({ chatId: 'chat-read', shell: 'zsh', cwd: '/home/me', cols: 80, rows: 24 });
  });

  it('returns all lines when the buffer is smaller than the default range', async () => {
    const { session, pty } = makeSession();
    pty.emitData(numberedLines(3));
    const result = await session.read({});
    expect(result).toMatchObject({ totalLines: 3, startLine: 1, endLine: 3 });
    expect(result.text).toBe('line 1\nline 2\nline 3');
  });

  it('pages with startLine and count', async () => {
    const { session, pty } = makeSession();
    pty.emitData(numberedLines(50));

    const page = await session.read({ startLine: 10, count: 5 });
    expect(page).toMatchObject({ totalLines: 50, startLine: 10, endLine: 14 });
    expect(page.text).toBe('line 10\nline 11\nline 12\nline 13\nline 14');

    // startLine alone runs to the end of the buffer, up to the default count.
    const fromLine = await session.read({ startLine: 5 });
    expect(fromLine).toMatchObject({ startLine: 5, endLine: 50 });
    expect(textLines(fromLine.text)).toHaveLength(46);

    const last = await session.read({ startLine: 50 });
    expect(last).toMatchObject({ startLine: 50, endLine: 50, text: 'line 50' });
  });

  it('clamps a count that runs past the end', async () => {
    const { session, pty } = makeSession();
    pty.emitData(numberedLines(50));
    const result = await session.read({ startLine: 48, count: 10 });
    expect(result).toMatchObject({ totalLines: 50, startLine: 48, endLine: 50 });
    expect(result.text).toBe('line 48\nline 49\nline 50');
  });

  it('returns at most readMaxLines lines, however large count is', async () => {
    const { session, pty } = makeSession();
    pty.emitData(numberedLines(1_200));

    const result = await session.read({ startLine: 1, count: 5_000 });
    expect(result).toMatchObject({ totalLines: 1_200, startLine: 1, endLine: 1_000, truncated: false });
    expect(textLines(result.text)).toHaveLength(TERMINAL.readMaxLines);
    expect(textLines(result.text).at(0)).toBe('line 1');
    expect(textLines(result.text).at(-1)).toBe('line 1000');

    // Both starts omitted: the last readMaxLines lines, counted from the end.
    const tail = await session.read({ count: 5_000 });
    expect(tail).toMatchObject({ startLine: 201, endLine: 1_200 });
    expect(textLines(tail.text)).toHaveLength(TERMINAL.readMaxLines);
  });
});

describe('read: logical lines', () => {
  it('excludes trailing blank lines from totalLines', async () => {
    const { session, pty } = makeSession();
    pty.emitData('a\r\n\r\n   \r\n\t\r\n');
    const result = await session.read({});
    expect(result.totalLines).toBe(1);
    expect(result).toMatchObject({ startLine: 1, endLine: 1, text: 'a' });
  });

  it('returns a wrapped row as one line and counts it as one', async () => {
    const { session, pty } = makeSession();
    const longLine = 'a'.repeat(100); // 80 columns: two rows
    pty.emitData(longLine);
    const result = await session.read({});
    expect(result).toMatchObject({ totalLines: 1, startLine: 1, endLine: 1 });
    expect(result.text).toBe(longLine);
  });

  it('keeps a space that sits at a wrap point', async () => {
    const { session, pty } = makeSession();
    // Column 80 of the first row is a space; trimming the rows before joining would lose it.
    const line = `${'a'.repeat(79)} b`;
    pty.emitData(line);
    const result = await session.read({});
    expect(result.totalLines).toBe(1);
    expect(result.text).toBe(line);
  });

  it('trims trailing spaces and drops escape codes and colours', async () => {
    const { session, pty } = makeSession();
    pty.emitData('\u001b[31mred\u001b[0m \u001b[1;32mbold\u001b[0m plain   \r\n');
    const result = await session.read({});
    expect(result.text).toBe('red bold plain');
    expect(result.text).not.toContain('\u001b');
  });

  it('shows only the final state of a carriage-return progress line', async () => {
    const { session, pty } = makeSession();
    pty.emitData('progress 10%\rprogress 50%\rprogress 100%\r\n');
    const result = await session.read({});
    expect(result).toMatchObject({ totalLines: 1, startLine: 1, endLine: 1 });
    expect(result.text).toBe('progress 100%');
  });

  it('returns no lines for an empty buffer', async () => {
    const { session } = makeSession();
    const result = await session.read({});
    expect(result).toMatchObject({ totalLines: 0, startLine: 0, endLine: 0, text: '', truncated: false });
  });

  it('returns the empty result for a startLine past the end', async () => {
    const { session, pty } = makeSession();
    pty.emitData('one\r\ntwo\r\nthree\r\n');
    const result = await session.read({ startLine: 4 });
    expect(result).toMatchObject({ totalLines: 3, startLine: 0, endLine: 0, text: '', truncated: false });
  });
});

describe('read: whole lines, never cut by bytes', () => {
  it('returns a very long line whole', async () => {
    const { session, pty } = makeSession();
    const longLine = 'x'.repeat(200_000);
    pty.emitData(longLine);
    const result = await session.read({});
    expect(result).toMatchObject({ totalLines: 1, startLine: 1, endLine: 1, truncated: false });
    expect(result.text).toBe(longLine);
    expect(result.text).toHaveLength(200_000);
  });

  it('never reports truncated from main, even past readMaxBytes', async () => {
    const { session, pty } = makeSession();
    // 1,000 lines of ~100 characters: well past the 50 KB the tool cuts at, not main's concern.
    const long = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1} ${'x'.repeat(100)}`).join('\r\n');
    pty.emitData(`${long}\r\n`);
    const result = await session.read({ count: TERMINAL.readMaxLines });
    expect(result).toMatchObject({ totalLines: 1_000, startLine: 1, endLine: 1_000, truncated: false });
    expect(result.text.length).toBeGreaterThan(TERMINAL.readMaxBytes);
  });

  it('sees output that was written just before the read', async () => {
    const { session, pty } = makeSession();
    pty.emitData('first\r\n');
    pty.emitData('second\r\n');
    // No await between the write and the read: read waits for the screen to catch up itself.
    const result = await session.read({});
    expect(result.text).toBe('first\nsecond');
  });

  it('includes output written between two reads on the next read', async () => {
    const { session, pty } = makeSession();
    pty.emitData('one\r\n');
    expect((await session.read({})).text).toBe('one');
    pty.emitData('two\r\n');
    const result = await session.read({ startLine: 2 });
    expect(result).toMatchObject({ totalLines: 2, startLine: 2, endLine: 2, text: 'two' });
  });
});
