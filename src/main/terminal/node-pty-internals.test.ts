// The node-pty internals the input bound reads (./node-pty-internals.ts; T1 review item 7). A real write queue needs
// a spawned shell, which unit tests never start, so this pins the version and checks node-pty's own source for the
// queue's shape; it fails on an upgrade until the reader is checked again. The real queue was measured by hand
// against a stopped shell (see the T1 fix report).

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { pendingWriteBytes } from './node-pty-internals';

describe('node-pty internals', () => {
  it('is the version the reader was written against, with the write queue it reads', async () => {
    const pkg = JSON.parse(await readFile('node_modules/node-pty/package.json', 'utf8')) as { version: string };
    expect(pkg.version).toBe('1.1.0');
    const source = await readFile('node_modules/node-pty/lib/unixTerminal.js', 'utf8');
    expect(source).toContain('_this._writeStream = new CustomWriteStream(');
    expect(source).toContain('this._writeQueue.push({ buffer: buffer, offset: 0 });');
    expect(source).toContain('task.offset += written;');
    expect(source).toContain('_this._writeQueue.shift();');
  });
});

describe('pendingWriteBytes', () => {
  it('sums what is left of each queued buffer', () => {
    const pty = {
      _writeStream: {
        _writeQueue: [
          { buffer: Buffer.alloc(100), offset: 40 },
          { buffer: Buffer.alloc(10), offset: 0 },
        ],
      },
    };
    expect(pendingWriteBytes(pty)).toBe(70);
    expect(pendingWriteBytes({ _writeStream: { _writeQueue: [] } })).toBe(0);
  });

  it('returns null when the shape is not what it expects', () => {
    for (const pty of [
      null,
      {},
      { _writeStream: null },
      { _writeStream: {} },
      { _writeStream: { _writeQueue: {} } },
      { _writeStream: { _writeQueue: [{ buffer: 'x', offset: 0 }] } },
      { _writeStream: { _writeQueue: [{ buffer: Buffer.alloc(1) }] } },
    ]) {
      expect(pendingWriteBytes(pty)).toBeNull();
    }
  });
});
