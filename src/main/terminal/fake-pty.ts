// A controllable PTY for the terminal tests (plan T1): records what a session does to it and lets a test fire output
// and exit events. It never spawns anything, so the unit tests don't need a real shell.

import type { PtyDisposable, PtyExit, PtyProcess } from './pty';

export interface FakePty extends PtyProcess {
  /** Every `write`, in order. */
  readonly writes: string[];
  /** Every `resize`, in order. */
  readonly resizes: Array<{ cols: number; rows: number }>;
  /** Every `kill` signal, in order. */
  readonly killSignals: string[];
  /** Every `kill` and `close`, in order, e.g. `['SIGHUP', 'close', 'SIGKILL']`. */
  readonly calls: string[];
  readonly closeCount: number;
  /** Live `onData`/`onExit` subscriptions, for checking that a finished session detaches. */
  readonly dataListenerCount: number;
  readonly exitListenerCount: number;
  /** Delivers output to every current `onData` listener. */
  emitData(data: string): void;
  /** Delivers an exit to every current `onExit` listener; `signal` follows node-pty's `IExitEvent`. */
  emitExit(exitCode: number, signal?: number): void;
  /** UTF-8 bytes written and not yet "read by the shell". Every write adds to it until `drainInput`. */
  readonly pendingBytes: number;
  /** The shell reads `bytes` of queued input (all of it when omitted). */
  drainInput(bytes?: number): void;
  /** What `pendingInputBytes()` answers from now on (see `FakePtyOptions.pendingInput`). */
  pendingInput: PendingInputMode;
}

/**
 * `tracked`: the real count. `unknown`: null, as when node-pty's internals have changed. `nan`, `negative`,
 * `infinite`: nonsense numbers. `throws`: the measurement throws.
 */
export type PendingInputMode = 'tracked' | 'unknown' | 'nan' | 'negative' | 'infinite' | 'throws';

export interface FakePtyOptions {
  pendingInput?: PendingInputMode;
}

export function createFakePty(pid = 4_242, options: FakePtyOptions = {}): FakePty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: PtyExit) => void>();
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const killSignals: string[] = [];
  const calls: string[] = [];
  let closeCount = 0;
  let pendingBytes = 0;

  const disposable = (remove: () => void): PtyDisposable => ({ dispose: remove });

  const fake: FakePty = {
    pid,
    pendingInput: options.pendingInput ?? 'tracked',
    get writes() {
      return writes;
    },
    get resizes() {
      return resizes;
    },
    get killSignals() {
      return killSignals;
    },
    get calls() {
      return calls;
    },
    get closeCount() {
      return closeCount;
    },
    get dataListenerCount() {
      return dataListeners.size;
    },
    get exitListenerCount() {
      return exitListeners.size;
    },
    onData(listener) {
      dataListeners.add(listener);
      return disposable(() => dataListeners.delete(listener));
    },
    onExit(listener) {
      exitListeners.add(listener);
      return disposable(() => exitListeners.delete(listener));
    },
    write(data) {
      writes.push(data);
      pendingBytes += Buffer.byteLength(data, 'utf8');
    },
    resize(cols, rows) {
      resizes.push({ cols, rows });
    },
    kill(signal) {
      killSignals.push(signal);
      calls.push(signal);
    },
    close() {
      closeCount += 1;
      calls.push('close');
    },
    emitData(data) {
      for (const listener of [...dataListeners]) listener(data);
    },
    emitExit(exitCode, signal) {
      for (const listener of [...exitListeners]) listener({ exitCode, signal });
    },
    get pendingBytes() {
      return pendingBytes;
    },
    drainInput(bytes) {
      pendingBytes = bytes === undefined ? 0 : Math.max(0, pendingBytes - bytes);
    },
    pendingInputBytes() {
      switch (fake.pendingInput) {
        case 'unknown':
          return null;
        case 'nan':
          return Number.NaN;
        case 'negative':
          return -1;
        case 'infinite':
          return Number.POSITIVE_INFINITY;
        case 'throws':
          throw new Error('internals changed');
        default:
          return pendingBytes;
      }
    },
  };
  return fake;
}
