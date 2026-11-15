// The only place that reads node-pty internals (1.1.0). node-pty queues every write until the shell reads it, with no
// limit and no public way to see how much is waiting, so the input bound (`TERMINAL.pendingInputMaxBytes`, plan §2
// "Limits") needs the size of that queue: `UnixTerminal._writeStream._writeQueue`, a list of `{ buffer, offset }` where
// `offset` bytes of `buffer` are already written. The shape is checked on every call; if it has changed,
// `pendingWriteBytes` returns null and the caller logs once and stops bounding, rather than guessing.
// node-pty-internals.test.ts checks the shape against a real node-pty PTY pair (opened without a process).

export interface WriteQueueEntry {
  buffer: { byteLength: number };
  offset: number;
}

/** Bytes written to the PTY that the shell has not read yet, or null when node-pty's internals are not as expected. */
export function pendingWriteBytes(pty: unknown): number | null {
  if (typeof pty !== 'object' || pty === null) return null;
  const stream = (pty as { _writeStream?: unknown })._writeStream;
  if (typeof stream !== 'object' || stream === null) return null;
  const queue = (stream as { _writeQueue?: unknown })._writeQueue;
  if (!Array.isArray(queue)) return null;
  let total = 0;
  for (const entry of queue as unknown[]) {
    const { buffer, offset } = (entry ?? {}) as Partial<WriteQueueEntry>;
    if (typeof buffer?.byteLength !== 'number' || typeof offset !== 'number') return null;
    total += buffer.byteLength - offset;
  }
  return total;
}
