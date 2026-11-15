// The raw replay buffer (docs/terminal-plan.md T1.2): the most recent `maxBytes` UTF-8 bytes, cut to a line start
// when older output goes, never splitting a surrogate pair.

import { TERMINAL } from '@shared/terminal';
import { describe, expect, it } from 'vitest';
import { ReplayBuffer } from './replay-buffer';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** Whether `text` holds a high surrogate without its low one, or a low one without its high one. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe('ReplayBuffer', () => {
  it('keeps everything, unmodified, while under the cap', () => {
    const buffer = new ReplayBuffer(1_024);
    buffer.append('\x1b[31mred\x1b[0m');
    buffer.append(' and ');
    buffer.append('\x1b[?1049h\r\n');
    expect(buffer.snapshot()).toStrictEqual({ text: '\x1b[31mred\x1b[0m and \x1b[?1049h\r\n', truncated: false });
    expect(buffer.size).toBe(bytes('\x1b[31mred\x1b[0m and \x1b[?1049h\r\n'));
  });

  it('defaults to the contract’s 2 MiB in the session (checked here as a constant)', () => {
    expect(TERMINAL.replayMaxBytes).toBe(2 * 1024 * 1024);
  });

  it('keeps the size at an exact cap without cutting', () => {
    const buffer = new ReplayBuffer(8);
    buffer.append('1234');
    buffer.append('5678');
    expect(buffer.snapshot()).toStrictEqual({ text: '12345678', truncated: false });
  });

  it('drops the oldest output, then up to and including the next line break', () => {
    const buffer = new ReplayBuffer(12);
    buffer.append('aaa\nbbb\n');
    buffer.append('ccc\nddd\n');
    // 16 bytes: 4 over. Dropping 'aaa\n' is exactly enough, and it ends at a line break.
    expect(buffer.snapshot()).toStrictEqual({ text: 'bbb\nccc\nddd\n', truncated: true });
    buffer.append('e');
    // 1 over: the cut goes past the next line break, so 'bbb\n' goes too.
    expect(buffer.snapshot()).toStrictEqual({ text: 'ccc\nddd\ne', truncated: true });
  });

  it('cuts inside a chunk and across chunks', () => {
    const buffer = new ReplayBuffer(10);
    buffer.append('ab');
    buffer.append('cd');
    buffer.append('ef\ngh\nij');
    // 12 bytes: 2 over, the next line break after that ends 'abcdef\n'.
    expect(buffer.snapshot()).toStrictEqual({ text: 'gh\nij', truncated: true });
  });

  it('keeps a \\r\\n pair whole: the cut is after the \\n', () => {
    const buffer = new ReplayBuffer(8);
    buffer.append('one\r\ntwo\r\n');
    expect(buffer.snapshot().text).toBe('two\r\n');
  });

  it('counts UTF-8 bytes, not UTF-16 units', () => {
    // 'é' is 2 bytes, '😀' is 4 bytes in 2 UTF-16 units.
    const buffer = new ReplayBuffer(10);
    buffer.append('éé\n😀\n');
    expect(bytes('éé\n😀\n')).toBe(10);
    expect(buffer.snapshot().truncated).toBe(false);
    buffer.append('x');
    expect(buffer.snapshot()).toStrictEqual({ text: '😀\nx', truncated: true });
    expect(buffer.size).toBe(6);
  });

  it('never splits a surrogate pair, however the cap falls', () => {
    for (let cap = 1; cap <= 40; cap++) {
      const buffer = new ReplayBuffer(cap);
      for (const chunk of ['😀😀\n', '😀a😀\n😀', '😀😀😀', '\n😀\n']) buffer.append(chunk);
      const { text } = buffer.snapshot();
      expect(hasLoneSurrogate(text)).toBe(false);
      expect(bytes(text)).toBeLessThanOrEqual(cap);
    }
  });

  it('stays within the cap for any sequence of appends, and always starts at a line start once truncated', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const alphabet = ['a', 'é', '😀', '\n', '\r\n', '\x1b[0m'];
    let all = '';
    const buffer = new ReplayBuffer(64);
    for (let step = 0; step < 2_000; step++) {
      let chunk = '';
      const length = Math.floor(random() * 30);
      for (let i = 0; i < length; i++) chunk += alphabet[Math.floor(random() * alphabet.length)];
      buffer.append(chunk);
      all += chunk;
      const { text, truncated } = buffer.snapshot();
      expect(bytes(text)).toBeLessThanOrEqual(64);
      expect(buffer.size).toBe(bytes(text));
      // What is kept is a suffix of everything written.
      expect(all.endsWith(text)).toBe(true);
      if (truncated && text.length > 0) {
        // It starts right after a line break in the full output.
        expect(all[all.length - text.length - 1]).toBe('\n');
      }
    }
  });

  it('holds nothing when the only line break is too old, and resumes after the next one', () => {
    const buffer = new ReplayBuffer(8);
    buffer.append('ab\n');
    buffer.append('cdefghijk');
    // 12 bytes, 4 over: no line break at or past byte 4.
    expect(buffer.snapshot()).toStrictEqual({ text: '', truncated: true });
    buffer.append('lmn');
    expect(buffer.snapshot().text).toBe('');
    buffer.append('op\nqr');
    expect(buffer.snapshot()).toStrictEqual({ text: 'qr', truncated: true });
  });

  it('handles one chunk larger than the cap', () => {
    const buffer = new ReplayBuffer(16);
    buffer.append(`${'x'.repeat(100)}\n${'y'.repeat(10)}\n`);
    expect(buffer.snapshot()).toStrictEqual({ text: `${'y'.repeat(10)}\n`, truncated: true });
  });

  it('stays bounded at the real cap under many small chunks', () => {
    const buffer = new ReplayBuffer(TERMINAL.replayMaxBytes);
    const line = `${'z'.repeat(99)}\n`;
    for (let i = 0; i < 50_000; i++) buffer.append(line);
    const { text, truncated } = buffer.snapshot();
    expect(truncated).toBe(true);
    expect(bytes(text)).toBeLessThanOrEqual(TERMINAL.replayMaxBytes);
    expect(bytes(text)).toBeGreaterThan(TERMINAL.replayMaxBytes - line.length);
    expect(text.startsWith('z')).toBe(true);
  });

  it('clear drops everything and keeps new output from the next line break on', () => {
    const buffer = new ReplayBuffer(1_024);
    buffer.append('crash me\r\n$ ');
    buffer.clear();
    expect(buffer.snapshot()).toStrictEqual({ text: '', truncated: true });
    expect(buffer.size).toBe(0);
    buffer.append('ls\r\nfile\r\n');
    expect(buffer.snapshot()).toStrictEqual({ text: 'file\r\n', truncated: true });
  });

  it('clear of an empty buffer drops nothing', () => {
    const buffer = new ReplayBuffer(1_024);
    buffer.clear();
    buffer.append('$ ');
    expect(buffer.snapshot()).toStrictEqual({ text: '$ ', truncated: false });
  });
});
