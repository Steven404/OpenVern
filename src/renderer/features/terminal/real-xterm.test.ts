import { terminalReadAnswerBody } from '@shared/api';
import { TERMINAL } from '@shared/terminal';
import { Terminal } from '@xterm/xterm';
import { expect, it } from 'vitest';
import { readTerminalBuffer as readBuffer } from './read';

const readTerminalBuffer: typeof readBuffer = (...args) => {
  const result = readBuffer(...args);
  expect(terminalReadAnswerBody.safeParse({ ok: true, result }).success).toBe(true);
  return result;
};

it('real xterm parses replay and subsequent output without ever opening a DOM element', async () => {
  const term = new Terminal({ cols: 20, rows: 5, scrollback: TERMINAL.scrollbackLines });
  try {
    await new Promise<void>((resolve) =>
      term.write(`12345678901234567890wrapped\r\nsecret sk-or-v1-${'a'.repeat(64)}`, resolve),
    );
    expect(term.element).toBeUndefined();
    const r = readTerminalBuffer(term.buffer.active, {
      chatId: 'a',
      shell: 'zsh',
      cwd: '/',
      cols: 20,
      rows: 5,
      status: { state: 'running' },
    });
    expect(r.text).toBe('12345678901234567890wrapped\nsecret «redacted:sk-or-v1-…»');
    await new Promise<void>((resolve) => term.write('\r\nmore', resolve));
    await new Promise<void>((resolve) => term.write('', resolve));
    expect(readTerminalBuffer(term.buffer.active, r.info).text).toContain('\nmore');
    await new Promise<void>((resolve) => term.write('\x1b[?1049h\x1b[Hvisible alternate screen', resolve));
    expect(readTerminalBuffer(term.buffer.active, r.info).text).toBe('visible alternate screen');
  } finally {
    term.dispose();
  }
});

const info = { chatId: 'a', shell: 'zsh', cwd: '/', cols: 80, rows: 5, status: { state: 'running' as const } };
async function withScreen(output: string, test: (term: Terminal) => void, cols = 80, scrollback = 100) {
  const term = new Terminal({ cols, rows: 5, scrollback });
  try {
    await new Promise<void>((resolve) => term.write(output, resolve));
    test(term);
  } finally {
    term.dispose();
  }
}

it('redacts the real zsh right-margin redraw even though erase clears isWrapped', async () => {
  const fixture = await import('./fixtures/zsh-margin.json');
  // The fixture stores runs of the placeholder letter as {{a:N}}, so the file holds no key-shaped text.
  const output = fixture.output.replace(/\{\{a:(\d+)\}\}/g, (_run, n: string) => 'a'.repeat(Number(n)));
  await withScreen(output, (term) => {
    expect(term.buffer.active.getLine(1)?.isWrapped).toBe(false);
    const all = readTerminalBuffer(term.buffer.active, info);
    expect(all.text).not.toContain('a'.repeat(8));
    expect(all.totalLines).toBe(2);
    expect(readTerminalBuffer(term.buffer.active, info, { startLine: 2 }).text).toContain('redacted');
  });
});

it('redacts cursor-positioned tokens with fewer than eight key characters on the first row and chains full rows', async () => {
  await withScreen(`${' '.repeat(69)}sk-or-v1-aa\x1b[2;1H${'a'.repeat(80)}\x1b[3;1H${'a'.repeat(20)}`, (term) => {
    const result = readTerminalBuffer(term.buffer.active, info);
    expect(result.totalLines).toBe(3);
    expect(result.text).not.toContain('aaaa');
    expect(result.text.split('\n').every((line) => line.includes('redacted'))).toBe(true);
  });
});

it('redacts a private-key tail after scrollback trims its BEGIN and a truncated replay with only END', async () => {
  const tail = 'fake-body\r\n-----END PRIVATE KEY-----\r\nsafe';
  await withScreen(tail, (term) => {
    expect(readTerminalBuffer(term.buffer.active, info).text).toBe('«redacted:terminal-fragment»\n\nsafe');
  });
  await withScreen(
    `-----BEGIN PRIVATE KEY-----\r\n${'fake-body\r\n'.repeat(8)}-----END PRIVATE KEY-----\r\nsafe`,
    (term) => {
      expect(term.buffer.active.getLine(0)?.translateToString()).not.toContain('BEGIN');
      expect(readTerminalBuffer(term.buffer.active, info).text).not.toContain('fake-body');
    },
    80,
    0,
  );
});

it('redacts a leading token after scrollback trims the start of a wrapped line', async () => {
  await withScreen(
    `${'a'.repeat(80 * 6)} remainder`,
    (term) => {
      expect(term.buffer.active.getLine(0)?.isWrapped).toBe(true);
      expect(readTerminalBuffer(term.buffer.active, info).text).toContain('«redacted:terminal-fragment» remainder');
      expect(readTerminalBuffer(term.buffer.active, info).text).not.toContain('aaaa');
    },
    80,
    0,
  );
});

it('finds a crossing secret starting after the first boundary in a consecutive full-row run', async () => {
  await withScreen(`${'x'.repeat(80)}\x1b[2;1Hsk-or-v1-${'a'.repeat(71)}\x1b[3;1H${'a'.repeat(10)}`, (term) => {
    expect(readTerminalBuffer(term.buffer.active, info).text).not.toContain('aaaa');
  });
});
