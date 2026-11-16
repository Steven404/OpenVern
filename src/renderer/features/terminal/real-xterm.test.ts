import { terminalReadAnswerBody } from '@shared/api';
import { TERMINAL } from '@shared/terminal';
import { redactTerminalText } from '@shared/terminal-redact';
import { Terminal } from '@xterm/xterm';
import { expect, it, vi } from 'vitest';
import { readTerminalBuffer as readBuffer } from './read';
import { TERMINAL_SKIPPED_OUTPUT, TerminalRegistry } from './registry';
import { FakeTerminalBridge } from './test-fakes';

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
  const tail = `${'QUJD'.repeat(8)}\r\n-----END PRIVATE KEY-----\r\nsafe`;
  await withScreen(tail, (term) => {
    expect(readTerminalBuffer(term.buffer.active, info).text).toBe(
      '«redacted:terminal-fragment»\n«redacted:terminal-fragment»\nsafe',
    );
  });
  await withScreen(
    `-----BEGIN PRIVATE KEY-----\r\n${(`${'QUJD'.repeat(8)}\r\n`).repeat(8)}-----END PRIVATE KEY-----\r\nsafe`,
    (term) => {
      expect(term.buffer.active.getLine(0)?.translateToString()).not.toContain('BEGIN');
      expect(readTerminalBuffer(term.buffer.active, info).text).not.toContain('QUJD');
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

for (const gutter of ['   1  ', '  │ ', '    ']) {
  for (const bodyOnFirstRow of [3, 23]) {
    it(`redacts numbered or bordered cursor-positioned rows (${JSON.stringify(gutter)}, ${bodyOnFirstRow} initial hex)`, async () => {
      const cols = 40;
      const key = `sk-or-v1-${'a'.repeat(64)}`;
      const first = `${gutter}${' '.repeat(cols - gutter.length - 9 - bodyOnFirstRow)}${key.slice(0, 9 + bodyOnFirstRow)}`;
      const rest = key.slice(9 + bodyOnFirstRow);
      const capacity = cols - gutter.length;
      const output =
        first +
        `\x1b[2;1H${gutter}${rest.slice(0, capacity)}` +
        (rest.length > capacity ? `\x1b[3;1H${gutter}${rest.slice(capacity)}` : '');
      await withScreen(
        output,
        (term) => {
          expect(term.buffer.active.getLine(1)?.isWrapped).toBe(false);
          const result = readTerminalBuffer(term.buffer.active, { ...info, cols });
          expect(result.text).not.toContain('aaa');
          expect(result.text.split('\n').every((line) => line.includes('redacted'))).toBe(true);
          expect(result.text.split('\n')[1]).toContain(gutter.trim());
        },
        cols,
      );
    });
  }
}

it('leaves margin-adjacent commit hashes and base64 without a vendor prefix unchanged', async () => {
  for (const token of ['a'.repeat(40), 'QUJD'.repeat(10)]) {
    await withScreen(
      `${token}\x1b[2;1H  2 │ ${token.slice(0, 30)}`,
      (term) => {
        expect(readTerminalBuffer(term.buffer.active, { ...info, cols: 40 }).text).toBe(
          `${token}\n  2 │ ${token.slice(0, 30)}`,
        );
      },
      40,
    );
  }
});

it('limits orphan BEGIN and END grep hits to their header lines and survives the backend second pass', async () => {
  for (const kind of ['BEGIN', 'END']) {
    const output = `prior npm test failed\r\ntest/key.pem:7:-----${kind} PRIVATE KEY-----\r\nlater npm test failed`;
    await withScreen(output, (term) => {
      const text = readTerminalBuffer(term.buffer.active, info).text;
      expect(text).toBe('prior npm test failed\n«redacted:terminal-fragment»\nlater npm test failed');
      expect(redactTerminalText(text).text).toBe(text);
    });
  }
});

it('redacts only contiguous base64 next to orphan headers, and complete blocks whole', async () => {
  const body = 'QUJD'.repeat(8);
  for (const content of [
    `before npm test\r\n-----BEGIN PRIVATE KEY-----\r\n${body}\r\nafter npm test`,
    `before npm test\r\n${body}\r\n${body}\r\n-----END PRIVATE KEY-----\r\nafter npm test`,
    `before npm test\r\n-----BEGIN PRIVATE KEY-----\r\nnon base64 content\r\n-----END PRIVATE KEY-----\r\nafter npm test`,
  ]) {
    await withScreen(content, (term) => {
      const text = readTerminalBuffer(term.buffer.active, info).text;
      expect(text).toContain('before npm test');
      expect(text).toContain('after npm test');
      expect(text).not.toContain(body);
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain('non base64 content');
      expect(redactTerminalText(text).text).toBe(text);
    });
  }
});

it('redacts the key body next to a lone header when every line carries a gutter or prefix', async () => {
  const body = ['TUlJRXZRSUJBREFOQmdrcWhraUc5dzBCQVFF', 'RkFBU0NCS2N3Z2dTakFnRUFBb0lCQVFD', 'N1ZKVFV0OVVzOGNLalFE'];
  const screens: Record<string, string[]> = {
    'vim with line numbers': ['  1 -----BEGIN PRIVATE KEY-----', ...body.map((line, i) => `  ${i + 2} ${line}`)],
    bat: ['   1   │ -----BEGIN PRIVATE KEY-----', ...body.map((line, i) => `   ${i + 2}   │ ${line}`)],
    'cat -n across a digit boundary': [
      '     9\t-----BEGIN PRIVATE KEY-----',
      ...body.map((line, i) => `    ${i + 10}\t${line}`),
    ],
    'a deleted key in a diff': ['------BEGIN PRIVATE KEY-----', ...body.map((line) => `-${line}`)],
    'grep with context': [
      'keys/a.pem:1:-----BEGIN PRIVATE KEY-----',
      ...body.map((line, i) => `keys/a.pem-${i + 2}-${line}`),
    ],
    'an old-style encrypted key': [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF',
      '',
      ...body,
    ],
    'the end of a numbered key': [...body.map((line, i) => `  ${i + 7} ${line}`), ' 10 -----END PRIVATE KEY-----'],
  };
  for (const [name, rows] of Object.entries(screens)) {
    await withScreen(['before npm test', ...rows, 'after npm test'].join('\r\n'), (term) => {
      const text = readTerminalBuffer(term.buffer.active, info).text;
      expect(text, name).toContain('before npm test');
      expect(text, name).toContain('after npm test');
      for (const line of body) expect(text, name).not.toContain(line);
      expect(text, name).not.toContain('PRIVATE KEY');
      expect(text, name).not.toContain('DEK-Info');
    });
  }
});

it('does not pair a header with an unrelated one far below it', async () => {
  const work = Array.from({ length: 150 }, (_, i) => `work line ${i}`);
  const content = [
    'test/a.pem:1:-----BEGIN PRIVATE KEY-----',
    ...work,
    'QUJDQUJDQUJDQUJD',
    '-----END PRIVATE KEY-----',
    'done',
  ];
  await withScreen(
    content.join('\r\n'),
    (term) => {
      const text = readTerminalBuffer(term.buffer.active, info, { startLine: 1, count: 200 }).text;
      expect(text).toContain('work line 0');
      expect(text).toContain('work line 149');
      expect(text).toContain('done');
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain('QUJDQUJDQUJDQUJD');
    },
    80,
    400,
  );
});

it('resynchronises a real xterm buffer after a rejected write and reads subsequent parsed output', async () => {
  const registry = new TerminalRegistry();
  const bridge = new FakeTerminalBridge();
  try {
    const entry = await registry.attach('a', bridge, { cwd: null });
    vi.spyOn(entry.term, 'write').mockImplementationOnce(() => {
      throw new Error('write data discarded');
    });
    bridge.emitData('a', 'recent output', 1);
    expect(await registry.read('a', bridge, {})).toEqual({ ok: false, reason: 'unavailable' });
    await vi.waitFor(() => expect(entry.notice).toBeNull());
    bridge.emitData('a', 'duplicate output', 1);
    bridge.emitData('a', 'after recovery', 2);
    const answer = await registry.read('a', bridge, {});
    expect(terminalReadAnswerBody.safeParse(answer).success).toBe(true);
    expect(answer).toMatchObject({ ok: true });
    if (answer.ok) {
      expect(answer.result.text).toContain('recent output');
      expect(answer.result.text).toContain(TERMINAL_SKIPPED_OUTPUT);
      expect(answer.result.text).toContain('after recovery');
      expect(answer.result.text).not.toContain('duplicate output');
    }
    expect(entry.term.element).toBeUndefined();
  } finally {
    registry.disposeAll();
  }
});

it('keeps hex digits after a numbered gutter inside the redacted continuation', async () => {
  const key = `sk-or-v1-${'1234567890abcdef'.repeat(4)}`;
  await withScreen(
    `   1  ${' '.repeat(22)}${key.slice(0, 12)}\x1b[2;1H   2  ${key.slice(12, 46)}\x1b[3;1H   3  ${key.slice(46)}`,
    (term) => {
      const text = readTerminalBuffer(term.buffer.active, { ...info, cols: 40 }).text;
      expect(text).not.toContain('456789');
      expect(text.split('\n').every((line) => line.includes('redacted'))).toBe(true);
    },
    40,
  );
});

it('recognises a vendor prefix itself split before a gutter', async () => {
  await withScreen(
    `${' '.repeat(38)}gh\x1b[2;1H  2 │ p_${'a'.repeat(25)}`,
    (term) => {
      expect(readTerminalBuffer(term.buffer.active, { ...info, cols: 40 }).text).not.toContain('aaa');
    },
    40,
  );
});
