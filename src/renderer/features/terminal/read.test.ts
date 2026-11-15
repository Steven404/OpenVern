import { TERMINAL, type TerminalInfo } from '@shared/terminal';
import { describe, expect, it, vi } from 'vitest';
import { type ReadBuffer, readTerminalBuffer } from './read';

const info: TerminalInfo = { chatId: 'c', shell: 'zsh', cwd: '/', cols: 80, rows: 24, status: { state: 'running' } };
function buffer(lines: string[], wrapped: number[] = []): ReadBuffer {
  return {
    length: lines.length,
    getLine: (i) => ({ isWrapped: wrapped.includes(i), translateToString: () => lines[i] ?? '' }),
  };
}
const read = (lines: string[], request = {}) => readTerminalBuffer(buffer(lines), info, request);
describe('renderer terminal read', () => {
  it('defaults to the last 200 logical lines and returns main info', () => {
    const r = read(Array.from({ length: 300 }, (_, i) => `${i + 1}`));
    expect(r).toMatchObject({ info, totalLines: 300, startLine: 101, endLine: 300, truncated: false });
    expect(r.text.split('\n')).toHaveLength(200);
  });
  it('pages, clamps the end and caps at readMaxLines', () => {
    expect(read(['a', 'b', 'c'], { startLine: 2, count: 9 })).toMatchObject({ startLine: 2, endLine: 3, text: 'b\nc' });
    expect(read(Array(1100).fill('a'), { startLine: 1, count: 2000 }).endLine).toBe(1000);
    expect(read(['a', 'b', 'c'], { count: 2 }).text).toBe('b\nc');
    expect(read(Array(300).fill('a'), { startLine: 1 }).endLine).toBe(200);
  });
  it('joins wrapped rows before trimming trailing spaces and blanks', () => {
    expect(readTerminalBuffer(buffer(['hello ', 'world  ', '', '  '], [1]), info)).toMatchObject({
      totalLines: 1,
      text: 'hello world',
    });
    expect(read(['a', '', 'b']).text).toBe('a\n\nb');
  });
  it('returns the exact empty result and real total for an empty or past-end buffer', () => {
    for (const lines of [[], ['', ' ']])
      expect(read(lines)).toMatchObject({ totalLines: 0, startLine: 0, endLine: 0, text: '' });
    expect(read(['a'], { startLine: 2 })).toMatchObject({ totalLines: 1, startLine: 0, endLine: 0, text: '' });
  });
  it('redacts vendor keys in the range and PEM blocks starting above it', () => {
    const fake = `sk-or-v1-${'a'.repeat(64)}`;
    expect(read([fake]).text).toBe('«redacted:sk-or-v1-…»');
    const r = read(
      ['-----BEGIN PRIVATE KEY-----', 'obviously-fake-private-material', '-----END PRIVATE KEY-----', 'safe'],
      { startLine: 2, count: 3 },
    );
    expect(r.text).toBe('\n\nsafe');
    expect(r.text.split('\n')).toHaveLength(r.endLine - r.startLine + 1);
  });
  it('redacts before a size cut could split a key or drop its prefix', () => {
    const fake = `sk-or-v1-${'a'.repeat(TERMINAL.readWireMaxChars)}`;
    const r = read([fake, 'safe']);
    expect(r.text).toBe('«redacted:sk-or-v1-…»\nsafe');
    expect(r.truncated).toBe(false);
  });
  it('drops whole lines from the start to fit the wire cap', () => {
    const r = read(['a'.repeat(TERMINAL.readWireMaxChars), 'b', 'c']);
    expect(r).toMatchObject({ startLine: 2, endLine: 3, text: 'b\nc', truncated: true });
    expect(r.text.split('\n')).toHaveLength(r.endLine - r.startLine + 1);
    expect(read(['a'.repeat(TERMINAL.readWireMaxChars)]).truncated).toBe(false);
  });
  it('replaces a single overlong line with one placeholder', () => {
    expect(read(['x'.repeat(TERMINAL.readWireMaxChars + 1)])).toMatchObject({
      startLine: 1,
      endLine: 1,
      text: '[Terminal line omitted: too long]',
      truncated: true,
    });
  });
  it('fails closed if redaction ever changes line count', async () => {
    const redact = await import('@shared/redact');
    const spy = vi.spyOn(redact, 'redactSecrets').mockReturnValue({ text: 'changed\nlines', count: 1 });
    try {
      expect(() => read(['one'])).toThrow('Redaction changed line numbers');
    } finally {
      spy.mockRestore();
    }
  });
});
