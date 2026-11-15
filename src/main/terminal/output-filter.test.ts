// The output filter (docs/terminal-plan.md §2, "Replay fidelity" and "Limits"; T1 review items 3 and 5): events end
// only where xterm's parser is at rest, and runs of zero-width code points are capped, across chunk boundaries. The
// scanner and the zero-width set are checked against xterm 6 itself.

import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import {
  COMBINING_RUN_MAX,
  HOLD_MAX_CHARS,
  isZeroWidthCandidate,
  nextParserState,
  OutputFilter,
  ParserState,
} from './output-filter';
import { readParserState, readWcwidth } from './xterm-internals';

const ACUTE = '\u0301';

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe('OutputFilter: events end with the parser at rest', () => {
  it('holds back an incomplete CSI until its final byte arrives', () => {
    const filter = new OutputFilter();
    expect(filter.push('red: \u001b[31')).toBe('red: ');
    expect(filter.atRest).toBe(false);
    expect(filter.push('mR')).toBe('\u001b[31mR');
    expect(filter.atRest).toBe(true);
  });

  it('holds back a lone ESC, an OSC without its terminator, and a DCS until ST', () => {
    const filter = new OutputFilter();
    expect(filter.push('a\u001b')).toBe('a');
    expect(filter.push('7b')).toBe('\u001b7b');
    expect(filter.push('\u001b]0;tit')).toBe('');
    expect(filter.push('le\u0007c')).toBe('\u001b]0;title\u0007c');
    expect(filter.push('\u001b]0;x\u001b')).toBe('');
    expect(filter.push('\\d')).toBe('\u001b]0;x\u001b\\d');
    expect(filter.push('\u001bPq#0;2;0;0;0')).toBe('');
    expect(filter.push('~-\u001b\\e')).toBe('\u001bPq#0;2;0;0;0~-\u001b\\e');
  });

  it('treats 8-bit C1 controls as xterm does', () => {
    const filter = new OutputFilter();
    // U+009B is CSI.
    expect(filter.push('x\u009b1')).toBe('x');
    expect(filter.push(';2H')).toBe('\u009b1;2H');
    // CAN aborts a sequence: the parser is back at rest.
    expect(filter.push('\u001b[12\u0018z')).toBe('\u001b[12\u0018z');
  });

  it('keeps a surrogate pair together across chunks', () => {
    const filter = new OutputFilter();
    const emoji = '😀';
    expect(filter.push(`a${emoji[0]}`)).toBe('a');
    expect(filter.push(`${emoji[1]}b`)).toBe(`${emoji}b`);
  });

  it('lets a sequence that never ends through once it is longer than the hold limit', () => {
    const filter = new OutputFilter({ holdMaxChars: 100 });
    expect(filter.push(`\u001b]0;${'x'.repeat(50)}`)).toBe('');
    const out = filter.push('y'.repeat(60));
    expect(out).toHaveLength(4 + 50 + 60);
    expect(filter.atRest).toBe(false);
    expect(HOLD_MAX_CHARS).toBe(1024 * 1024);
  });

  it('flush returns what is held', () => {
    const filter = new OutputFilter();
    filter.push('ok \u001b[3');
    expect(filter.flush()).toBe('\u001b[3');
    expect(filter.flush()).toBe('');
  });
});

describe('OutputFilter: runs of zero-width code points are capped', () => {
  it('keeps COMBINING_RUN_MAX marks after a base and drops the rest of the run', () => {
    expect(COMBINING_RUN_MAX).toBe(16);
    const filter = new OutputFilter();
    expect(filter.push(`e${ACUTE.repeat(40)}x${ACUTE.repeat(3)}`)).toBe(`e${ACUTE.repeat(16)}x${ACUTE.repeat(3)}`);
  });

  it('counts the run across chunk boundaries', () => {
    const filter = new OutputFilter();
    let out = filter.push('e');
    for (let i = 0; i < 100; i++) out += filter.push(ACUTE);
    expect(out).toBe(`e${ACUTE.repeat(COMBINING_RUN_MAX)}`);
  });

  it('caps astral zero-width code points (variation selectors supplement)', () => {
    const filter = new OutputFilter();
    const vs = '\u{E0100}';
    expect(filter.push(`a${vs.repeat(30)}`)).toBe(`a${vs.repeat(COMBINING_RUN_MAX)}`);
  });

  it('leaves marks inside an OSC string alone', () => {
    const filter = new OutputFilter();
    const title = `\u001b]0;e${ACUTE.repeat(40)}\u0007`;
    expect(filter.push(title)).toBe(title);
  });

  it('bounds what one cell holds in xterm: the reviewer’s 2.6 million marks become 16', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const filter = new OutputFilter();
    // Sent in 64 KiB chunks, as a PTY delivers it.
    const chunk = ACUTE.repeat(65_536);
    await write(term, filter.push('a'));
    for (let sent = 0; sent < 2_600_000; sent += chunk.length) await write(term, filter.push(chunk));
    const cell = term.buffer.active.getLine(0)?.getCell(0);
    expect(cell?.getChars()).toBe(`a${ACUTE.repeat(COMBINING_RUN_MAX)}`);
    term.dispose();
  });

  it('xterm joins marks only after a printed character: escapes between do not add to a cell', async () => {
    // The reason the cap per run is a cap per cell (see the header of output-filter.ts).
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await write(term, `a${ACUTE}\u001b[1;2H${ACUTE}\u001b[m${ACUTE}`);
    expect(term.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe(`a${ACUTE}`);
    term.dispose();
  });
});

describe('agreement with xterm 6', () => {
  it('every code point xterm gives no width is a zero-width candidate', () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const wcwidth = readWcwidth(term);
    const missing: string[] = [];
    for (let code = 0xa0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (wcwidth(code) === 0 && !isZeroWidthCandidate(code)) missing.push(code.toString(16));
    }
    expect(missing).toStrictEqual([]);
    term.dispose();
  });

  it('the scanner reaches the same parser state as xterm on random streams', async () => {
    const alphabet = [
      '\u001b',
      '[',
      ']',
      'P',
      'X',
      '^',
      '_',
      '\\',
      '(',
      '3',
      '1',
      ';',
      '?',
      '>',
      '<',
      ' ',
      '"',
      '$',
      'm',
      'h',
      'q',
      'A',
      '~',
      '\u0007',
      '\u0018',
      '\u001a',
      '\u001c',
      '\u0005',
      '\n',
      '\r',
      '\u0090',
      '\u009b',
      '\u009c',
      '\u009d',
      '\u009e',
      '\u0085',
      'é',
      ACUTE,
      '中',
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const mismatches: string[] = [];
    for (let run = 0; run < 1_500; run++) {
      let text = '';
      let state: ParserState = ParserState.GROUND;
      for (let i = 0; i < 24; i++) {
        const ch = alphabet[Math.floor(random() * alphabet.length)] ?? 'a';
        text += ch;
        state = nextParserState(state, ch.codePointAt(0) ?? 0);
      }
      await write(term, text);
      if (readParserState(term) !== state) mismatches.push(JSON.stringify(text));
      // CAN returns both to ground for the next run.
      await write(term, '\u0018');
    }
    expect(mismatches).toStrictEqual([]);
    term.dispose();
  }, 30_000);
});
