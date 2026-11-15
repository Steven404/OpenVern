// The slice of a PTY the terminal service uses. node-pty's `IPty` satisfies it structurally, so the service can be
// driven by a fake in tests; only ./service.ts imports node-pty itself.

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (exit: PtyExit) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Sends a signal (`SIGHUP` when omitted) to the shell. */
  kill(signal?: string): void;
  /** Stops reading output until `resume()`; used for flow control. */
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

/** Starts a process on a new PTY. Throws when the spawn fails (e.g. `posix_spawnp failed.`). */
export type SpawnPty = (file: string, args: readonly string[], options: PtySpawnOptions) => PtyProcess;
