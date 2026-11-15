// The node-pty internals the service reaches into (./node-pty-internals.ts). A real write queue needs a spawned
// shell, which unit tests never start, so this pins the version and checks node-pty's own source for the shapes the
// readers expect; it fails on an upgrade until they are checked again.

import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { closeWithoutSignal, pendingWriteBytes } from './node-pty-internals';

describe('node-pty internals', () => {
  it('is the version the readers were written against, with the write queue and destroy they rely on', async () => {
    const pkg = JSON.parse(await readFile('node_modules/node-pty/package.json', 'utf8')) as { version: string };
    expect(pkg.version).toBe('1.1.0');
    const source = await readFile('node_modules/node-pty/lib/unixTerminal.js', 'utf8');
    // The write queue pendingWriteBytes measures.
    expect(source).toContain('_this._writeStream = new CustomWriteStream(');
    expect(source).toContain('this._writeQueue.push({ buffer: buffer, offset: 0 });');
    expect(source).toContain('task.offset += written;');
    expect(source).toContain('_this._writeQueue.shift();');
    // destroy() closes the socket and then signals through this.kill, which closeWithoutSignal switches off.
    const destroy = /UnixTerminal\.prototype\.destroy = function \(\) \{([\s\S]*?)\n {4}\};/.exec(source)?.[1];
    expect(destroy).toBeDefined();
    expect(destroy).toContain("_this.kill('SIGHUP');");
    expect(destroy).toContain('this._socket.destroy();');
    expect(destroy?.match(/kill/g)).toHaveLength(1);
    expect(source).toContain("process.kill(this.pid, signal || 'SIGHUP');");
    // The exit is still reported after destroy(): onexit emits at once when the socket has already closed.
    expect(source).toContain('if (!_this._emittedClose) {');
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
      { _writeStream: { _writeQueue: [null] } },
      { _writeStream: { _writeQueue: [{ buffer: 'x', offset: 0 }] } },
      { _writeStream: { _writeQueue: [{ buffer: Buffer.alloc(1) }] } },
    ]) {
      expect(pendingWriteBytes(pty)).toBeNull();
    }
  });

  it('returns null for nonsense numbers rather than a count', () => {
    const queue = (entry: unknown) => ({ _writeStream: { _writeQueue: [entry] } });
    for (const entry of [
      { buffer: { byteLength: Number.NaN }, offset: 0 },
      { buffer: { byteLength: Number.POSITIVE_INFINITY }, offset: 0 },
      { buffer: { byteLength: -1 }, offset: 0 },
      { buffer: { byteLength: 1.5 }, offset: 0 },
      { buffer: Buffer.alloc(10), offset: -1 },
      { buffer: Buffer.alloc(10), offset: Number.NaN },
      { buffer: Buffer.alloc(10), offset: 11 },
    ]) {
      expect(pendingWriteBytes(queue(entry))).toBeNull();
    }
  });
});

describe('closeWithoutSignal', () => {
  it('calls destroy with kill switched off, so the late SIGHUP after the socket closes goes nowhere', () => {
    const signals: string[] = [];
    const pty = {
      closeListeners: [] as Array<() => void>,
      kill(signal?: string) {
        signals.push(signal ?? 'SIGHUP');
      },
      destroy() {
        // What node-pty 1.1.0 does: on the socket's close, this.kill('SIGHUP').
        this.closeListeners.push(() => this.kill('SIGHUP'));
      },
    };
    expect(closeWithoutSignal(pty)).toBe(true);
    for (const listener of pty.closeListeners) listener();
    expect(signals).toStrictEqual([]);
  });

  it('does nothing when the shape differs', () => {
    const destroy = vi.fn();
    expect(closeWithoutSignal(null)).toBe(false);
    expect(closeWithoutSignal({})).toBe(false);
    expect(closeWithoutSignal({ destroy })).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });
});
