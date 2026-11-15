// A controllable PTY for the terminal tests (plan T1): records what a session does to it and lets a test fire output
// and exit events. It never spawns anything, so the unit tests don't need a real shell.

import type { PtyDisposable, PtyExit, PtyProcess } from './pty';

export interface FakePty extends PtyProcess {
  /** Every `write`, in order. */
  readonly writes: string[];
  /** Every `resize`, in order. */
  readonly resizes: Array<{ cols: number; rows: number }>;
  /** Every `kill` signal, in order; `undefined` is node-pty's default (SIGHUP). */
  readonly killSignals: Array<string | undefined>;
  readonly pauseCount: number;
  readonly resumeCount: number;
  /** Live `onData`/`onExit` subscriptions, for checking that a closed session detaches. */
  readonly dataListenerCount: number;
  readonly exitListenerCount: number;
  /** Delivers output to every current `onData` listener. */
  emitData(data: string): void;
  /** Delivers an exit to every current `onExit` listener; `signal` follows node-pty's `IExitEvent`. */
  emitExit(exitCode: number, signal?: number): void;
}

export function createFakePty(pid = 4_242): FakePty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: PtyExit) => void>();
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const killSignals: Array<string | undefined> = [];
  let pauseCount = 0;
  let resumeCount = 0;

  const disposable = (remove: () => void): PtyDisposable => ({ dispose: remove });

  return {
    pid,
    get writes() {
      return writes;
    },
    get resizes() {
      return resizes;
    },
    get killSignals() {
      return killSignals;
    },
    get pauseCount() {
      return pauseCount;
    },
    get resumeCount() {
      return resumeCount;
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
    },
    resize(cols, rows) {
      resizes.push({ cols, rows });
    },
    kill(signal) {
      killSignals.push(signal);
    },
    pause() {
      pauseCount += 1;
    },
    resume() {
      resumeCount += 1;
    },
    emitData(data) {
      for (const listener of [...dataListeners]) listener(data);
    },
    emitExit(exitCode, signal) {
      for (const listener of [...exitListeners]) listener({ exitCode, signal });
    },
  };
}
