// Payload validation at the IPC boundary (docs/terminal-plan.md T1.5). Each parser returns null for a payload it
// refuses and never throws; the handlers turn that into a rejection or an ignored message.

import { TERMINAL } from '@shared/terminal';
import { describe, expect, it } from 'vitest';
import { parseChatId, parseOpenRequest, parseReadRequest, parseSize, parseWriteData } from './validate';

describe('parseChatId', () => {
  it('accepts ids made of letters, digits, dashes and underscores', () => {
    expect(parseChatId('4a6c2f1e-9b5d-4a3c-8f2e-1d2c3b4a5f60')).toBe('4a6c2f1e-9b5d-4a3c-8f2e-1d2c3b4a5f60');
    expect(parseChatId('chat_1-A')).toBe('chat_1-A');
    expect(parseChatId('x'.repeat(128))).toBe('x'.repeat(128));
  });

  it('refuses anything else, including the index id', () => {
    for (const value of [
      'index',
      '',
      'bad id',
      'chat/1',
      'chat.1',
      'x'.repeat(129),
      null,
      undefined,
      7,
      {},
      [],
      true,
    ]) {
      expect(parseChatId(value)).toBeNull();
    }
  });
});

describe('parseSize', () => {
  it('floors and clamps to the limits', () => {
    expect(parseSize(0, 0)).toStrictEqual({ cols: TERMINAL.minCols, rows: TERMINAL.minRows });
    expect(parseSize(-10, -10)).toStrictEqual({ cols: TERMINAL.minCols, rows: TERMINAL.minRows });
    expect(parseSize(100_000, 100_000)).toStrictEqual({ cols: TERMINAL.maxCols, rows: TERMINAL.maxRows });
    expect(parseSize(99.9, 39.9)).toStrictEqual({ cols: 99, rows: 39 });
    expect(parseSize(80, 24)).toStrictEqual({ cols: 80, rows: 24 });
    expect(parseSize(TERMINAL.minCols, TERMINAL.minRows)).toStrictEqual({
      cols: TERMINAL.minCols,
      rows: TERMINAL.minRows,
    });
    expect(parseSize(TERMINAL.maxCols, TERMINAL.maxRows)).toStrictEqual({
      cols: TERMINAL.maxCols,
      rows: TERMINAL.maxRows,
    });
  });

  it('refuses non-finite and non-numeric values', () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '80',
      null,
      undefined,
      {},
      [],
    ]) {
      expect(parseSize(value, 24)).toBeNull();
      expect(parseSize(80, value)).toBeNull();
    }
  });
});

describe('parseOpenRequest', () => {
  it('accepts an absolute, a relative or a null cwd, and returns only the contract fields', () => {
    expect(parseOpenRequest({ chatId: 'chat-1', cwd: '/project', cols: 100, rows: 30 })).toStrictEqual({
      chatId: 'chat-1',
      cwd: '/project',
      cols: 100,
      rows: 30,
    });
    expect(parseOpenRequest({ chatId: 'chat-1', cwd: 'relative/dir', cols: 80, rows: 24 })).toStrictEqual({
      chatId: 'chat-1',
      cwd: 'relative/dir',
      cols: 80,
      rows: 24,
    });
    expect(parseOpenRequest({ chatId: 'chat-1', cwd: null, cols: 80, rows: 24 })).toStrictEqual({
      chatId: 'chat-1',
      cwd: null,
      cols: 80,
      rows: 24,
    });
    // Extra fields are dropped, not forwarded to the manager.
    expect(
      parseOpenRequest({ chatId: 'chat-1', cwd: null, cols: 80, rows: 24, shell: '/bin/sh', extra: true }),
    ).toStrictEqual({ chatId: 'chat-1', cwd: null, cols: 80, rows: 24 });
  });

  it('clamps the size in an open request', () => {
    expect(parseOpenRequest({ chatId: 'chat-1', cwd: null, cols: 0, rows: 0 })).toMatchObject({
      cols: TERMINAL.minCols,
      rows: TERMINAL.minRows,
    });
  });

  it('refuses malformed requests', () => {
    for (const value of [null, undefined, 7, 'open', [], true]) {
      expect(parseOpenRequest(value)).toBeNull();
    }
    expect(parseOpenRequest({ cwd: null, cols: 80, rows: 24 })).toBeNull();
    expect(parseOpenRequest({ chatId: 'bad id', cwd: null, cols: 80, rows: 24 })).toBeNull();
    expect(parseOpenRequest({ chatId: 'chat-1', cwd: 7, cols: 80, rows: 24 })).toBeNull();
    expect(parseOpenRequest({ chatId: 'chat-1', cwd: '/tmp/a\0b', cols: 80, rows: 24 })).toBeNull();
    expect(parseOpenRequest({ chatId: 'chat-1', cwd: `/${'a'.repeat(4_096)}`, cols: 80, rows: 24 })).toBeNull();
    expect(parseOpenRequest({ chatId: 'chat-1', cwd: null, cols: Number.NaN, rows: 24 })).toBeNull();
    expect(parseOpenRequest({ chatId: 'chat-1', cwd: null, cols: 80, rows: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('accepts a cwd at the length limit', () => {
    const cwd = `/${'a'.repeat(4_095)}`;
    expect(parseOpenRequest({ chatId: 'chat-1', cwd, cols: 80, rows: 24 })).toMatchObject({ cwd });
  });
});

describe('parseWriteData', () => {
  it('accepts strings up to writeMaxBytes, measured in UTF-8 bytes', () => {
    expect(parseWriteData('')).toBe('');
    expect(parseWriteData('ls\r')).toBe('ls\r');
    expect(parseWriteData('a'.repeat(TERMINAL.writeMaxBytes))).toHaveLength(TERMINAL.writeMaxBytes);
    // 16,384 four-byte emoji: 32,768 UTF-16 units but exactly writeMaxBytes of UTF-8.
    const emoji = '😀'.repeat(16_384);
    expect(parseWriteData(emoji)).toBe(emoji);
  });

  it('refuses anything longer, whole rather than cutting it', () => {
    expect(parseWriteData('a'.repeat(TERMINAL.writeMaxBytes + 1))).toBeNull();
    expect(parseWriteData(`${'😀'.repeat(16_384)}a`)).toBeNull();
    for (const value of [null, undefined, 7, {}, [], true]) {
      expect(parseWriteData(value)).toBeNull();
    }
  });
});

describe('parseReadRequest', () => {
  it('accepts omitted, partial and full requests', () => {
    expect(parseReadRequest(undefined)).toStrictEqual({});
    expect(parseReadRequest({})).toStrictEqual({});
    expect(parseReadRequest({ startLine: 1 })).toStrictEqual({ startLine: 1 });
    expect(parseReadRequest({ count: 1 })).toStrictEqual({ count: 1 });
    expect(parseReadRequest({ startLine: 4_800, count: 200 })).toStrictEqual({ startLine: 4_800, count: 200 });
  });

  it('accepts a count above readMaxLines: the screen caps it, validation does not refuse it', () => {
    expect(parseReadRequest({ count: TERMINAL.readMaxLines + 1 })).toStrictEqual({ count: TERMINAL.readMaxLines + 1 });
    expect(parseReadRequest({ count: 1_000_000 })).toStrictEqual({ count: 1_000_000 });
  });

  it('refuses a request that is not an object of positive integers', () => {
    for (const value of [null, 7, 'last 10', [], true]) {
      expect(parseReadRequest(value)).toBeNull();
    }
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(parseReadRequest({ startLine: value })).toBeNull();
      expect(parseReadRequest({ count: value })).toBeNull();
    }
  });
});
