// The @xterm/headless internals the snapshot depends on (./xterm-internals.ts). These fail loudly when an upgrade
// moves or renames them, before a wrong screen is ever replayed.

import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { readParserState, readScreenInternals, readWcwidth, XtermInternalsError } from './xterm-internals';

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe('xterm internals', () => {
  it('is the version these reads were written against', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile('node_modules/@xterm/headless/package.json', 'utf8')) as { version: string };
    // On an upgrade: re-check every field in xterm-internals.ts against the new source, then update this.
    expect(pkg.version).toBe('6.0.0');
  });

  it('reads the default region, saved cursor and pen of a fresh terminal', () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const internals = readScreenInternals(term);
    expect(internals).toMatchObject({ scrollTop: 0, scrollBottom: 23, savedX: 0, savedY: 0 });
    expect(internals.savedAttributes.isBold()).toBe(0);
    expect(internals.currentAttributes.getFgColorMode()).toBe(0);
    expect(readParserState(term)).toBe(0);
    term.dispose();
  });

  it('follows DECSTBM, DECSC and SGR', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await write(term, '\u001b[3;10r\u001b[5;7H\u001b[1;31m\u001b7\u001b[0;32m\u001b[1');
    const internals = readScreenInternals(term);
    expect(internals).toMatchObject({ scrollTop: 2, scrollBottom: 9, savedX: 6, savedY: 4 });
    expect(internals.savedAttributes.isBold()).not.toBe(0);
    expect(internals.savedAttributes.getFgColor()).toBe(1);
    expect(internals.currentAttributes.isBold()).toBe(0);
    expect(internals.currentAttributes.getFgColor()).toBe(2);
    // Inside a CSI: the parser is not at rest.
    expect(readParserState(term)).not.toBe(0);
    expect(readWcwidth(term)(0x301)).toBe(0);
    expect(readWcwidth(term)(0x4e2d)).toBe(2);
    term.dispose();
  });

  it('throws XtermInternalsError when a field is missing', () => {
    const fake = { _core: { buffer: { scrollTop: 0 }, _inputHandler: {} } } as unknown as Terminal;
    expect(() => readScreenInternals(fake)).toThrow(XtermInternalsError);
    expect(() => readScreenInternals({} as Terminal)).toThrow(/internals changed/);
  });
});
