// The only place that reaches into node-pty (1.1.0) past its typed API. Each reader checks the shape on every call
// and reports when it is not what it expects, so the caller fails closed rather than guessing.
// node-pty-internals.test.ts pins the version and checks node-pty's own source for these shapes.

export interface WriteQueueEntry {
  buffer: { byteLength: number };
  offset: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Bytes written to the PTY that the shell has not read yet, or null when node-pty's internals are not as expected.
 * node-pty queues every write until the shell reads it, with no limit and no public way to see how much is waiting:
 * `UnixTerminal._writeStream._writeQueue` is a list of `{ buffer, offset }` where `offset` bytes of `buffer` are
 * already written. Every number is checked (whole, non-negative, `offset <= byteLength`).
 */
export function pendingWriteBytes(pty: unknown): number | null {
  if (typeof pty !== 'object' || pty === null) return null;
  const stream = (pty as { _writeStream?: unknown })._writeStream;
  if (typeof stream !== 'object' || stream === null) return null;
  const queue = (stream as { _writeQueue?: unknown })._writeQueue;
  if (!Array.isArray(queue)) return null;
  let total = 0;
  for (const entry of queue as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { buffer, offset } = entry as Partial<WriteQueueEntry>;
    const size = typeof buffer === 'object' && buffer !== null ? buffer.byteLength : undefined;
    if (!isCount(size) || !isCount(offset) || offset > size) return null;
    total += size - offset;
  }
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Closes the PTY's master side, which hangs up the shell's session, and sends no signal. node-pty's `destroy()`
 * closes the socket and then, once it has closed, SIGHUPs the pid itself, at a moment when the shell may already have
 * exited and been reaped. The session sends its own SIGHUP while the shell is known to be alive, so that late one is
 * switched off by replacing the instance's `kill` first. Returns false (and does nothing) when the shape differs.
 */
export function closeWithoutSignal(pty: unknown): boolean {
  if (typeof pty !== 'object' || pty === null) return false;
  const target = pty as { destroy?: unknown; kill?: unknown };
  if (typeof target.destroy !== 'function' || typeof target.kill !== 'function') return false;
  target.kill = () => {};
  (target.destroy as () => void).call(pty);
  return true;
}
