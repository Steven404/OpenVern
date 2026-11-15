// The read contract (docs/terminal-plan.md §4.1, T1.4): logical lines, whole lines, redacted over the whole buffer
// before anything is selected, and bounded by `readWireMaxChars` by dropping whole lines, never by a cut inside one.
// Reads go through a real TerminalSession and a real headless xterm, driven by a fake PTY.

import { sentinel } from '@shared/redact';
import { TERMINAL } from '@shared/terminal';
import { describe, expect, it } from 'vitest';
import { createFakePty, type FakePty } from './fake-pty';
import { COMBINING_RUN_MAX } from './output-filter';
import { omittedLinePlaceholder, readLines, TerminalScreen } from './screen';
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

describe('read: redaction comes first, over the whole buffer', () => {
  const KEY = `sk-or-v1-${'0123456789abcdef'.repeat(4)}`;

  it('redacts a vendor key in the range', async () => {
    const { session, pty } = makeSession();
    pty.emitData(`export OPENROUTER_API_KEY=${KEY}\r\nok\r\n`);
    const result = await session.read({});
    expect(result.text).not.toContain(KEY);
    expect(result.text).toBe(`export OPENROUTER_API_KEY=${sentinel('sk-or-v1-…')}\nok`);
    expect(result).toMatchObject({ totalLines: 2, startLine: 1, endLine: 2 });
  });

  it('redacts the body of a private key whose BEGIN line is above the requested range', () => {
    const lines = [
      'cat id_rsa',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAsecretbodyline1',
      'secretbodyline2xxxxxxxxxxxxxxxx',
      '-----END RSA PRIVATE KEY-----',
      'after',
    ];
    const result = readLines(lines, { startLine: 3, count: 4 });
    expect(result).toMatchObject({ totalLines: 6, startLine: 3, endLine: 6, truncated: false });
    expect(result.text).not.toContain('secretbody');
    // Line numbers are unchanged: the block's lines become empty, the line after it stays line 6.
    expect(result.text.split('\n')).toStrictEqual(['', '', '', 'after']);
  });

  it('redacts a key that a size cut would have split, because the cut comes after', () => {
    const lines = ['a'.repeat(30), `${KEY} tail`];
    const result = readLines(lines, {}, 40);
    expect(result.text).not.toContain(KEY.slice(9));
    expect(result).toMatchObject({ startLine: 2, endLine: 2, truncated: true });
  });
});

describe('read: bounded by readWireMaxChars, whole lines only', () => {
  it('drops whole lines from the start of the range and names the first line kept', () => {
    const lines = ['one', 'two', 'three', 'four'];
    // 'three\nfour' is 10 characters.
    const result = readLines(lines, { startLine: 1, count: 4 }, 10);
    expect(result).toMatchObject({ totalLines: 4, startLine: 3, endLine: 4, text: 'three\nfour', truncated: true });
  });

  it('keeps everything and reports no truncation when it fits exactly', () => {
    const result = readLines(['one', 'two'], {}, 7);
    expect(result).toMatchObject({ startLine: 1, endLine: 2, text: 'one\ntwo', truncated: false });
  });

  it('replaces a single line longer than the limit with a placeholder', () => {
    const lines = ['before', 'x'.repeat(50), 'after'];
    const result = readLines(lines, { startLine: 2, count: 1 }, 40);
    expect(result).toMatchObject({ startLine: 2, endLine: 2, truncated: true });
    expect(result.text).toBe(omittedLinePlaceholder(2, 50));
    expect(result.text).not.toContain('xxxxx');
  });

  it('the reviewer’s 2,600,011-character line: a placeholder, within the wire limit', () => {
    const huge = `a${'\u0301'.repeat(2_600_010)}`;
    const result = readLines(['$ cat zalgo.txt', huge, '$'], {});
    expect(result.text.length).toBeLessThanOrEqual(TERMINAL.readWireMaxChars);
    expect(result).toMatchObject({ totalLines: 3, startLine: 1, endLine: 3, truncated: true });
    expect(result.text).toBe(`$ cat zalgo.txt\n${omittedLinePlaceholder(2, 2_600_011)}\n$`);
  });

  it('the reviewer’s stream through a session: marks are capped before the screen, so the line is short', async () => {
    const { session, pty } = makeSession();
    pty.emitData('a');
    const chunk = '\u0301'.repeat(65_536);
    for (let sent = 0; sent < 2_600_010; sent += chunk.length) pty.emitData(chunk);
    pty.emitData('\r\n');
    const result = await session.read({});
    expect(result.text).toBe(`a${'\u0301'.repeat(COMBINING_RUN_MAX)}`);
    expect(result.truncated).toBe(false);
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

  it('does not apply the tool’s readMaxBytes: main only bounds by readWireMaxChars', async () => {
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
