// The slice of a PTY the terminal service uses, so the service can be driven by a fake in tests. Only ./service.ts
// imports node-pty itself and adapts it to this.

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
  /** Reported once the shell has been reaped (node-pty: up to 200 ms later). */
  onExit(listener: (exit: PtyExit) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Sends `signal` to the shell's pid. The caller decides when that pid is still the shell. */
  kill(signal: 'SIGHUP' | 'SIGKILL'): void;
  /** Closes the terminal device (the master side), which hangs up the shell's session. Sends no signal itself. */
  close(): void;
  /**
   * Bytes written but not yet read by the shell (node-pty queues them without limit), or null when that cannot be
   * told. Used to bound queued input (`TERMINAL.pendingInputMaxBytes`); the caller refuses input when it cannot be
   * told.
   */
  pendingInputBytes(): number | null;
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
