// One terminal session: a PTY running the shell plus the headless screen its output is written into (plan T1.2).
// Output goes to the screen and out as data events with a sequence number that increases by one per event, so a
// reattaching renderer can tell which events its snapshot already holds.

import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalStatus,
} from '@shared/terminal';
import type { Id } from '@shared/types';
import type { PtyDisposable, PtyProcess } from './pty';
import type { TerminalScreen } from './screen';

/** How long a shell gets after SIGHUP before SIGKILL, and again after SIGKILL before giving up on its exit. */
export const KILL_GRACE_MS = 1_000;

// Flow control: stop reading the PTY while this much output (in UTF-16 units) is waiting to be parsed.
const BACKLOG_HIGH = 1024 * 1024;
const BACKLOG_LOW = 128 * 1024;

export interface SessionEvents {
  data(event: TerminalDataEvent): void;
  exit(event: TerminalExitEvent): void;
}

export interface SessionOptions {
  chatId: Id;
  pty: PtyProcess;
  screen: TerminalScreen;
  /** Basename of the shell, e.g. `zsh`. */
  shell: string;
  cwd: string;
  events: SessionEvents;
  killGraceMs?: number;
}

export class TerminalSession {
  readonly chatId: Id;
  private readonly pty: PtyProcess;
  private readonly screen: TerminalScreen;
  private readonly shell: string;
  private readonly cwd: string;
  private readonly events: SessionEvents;
  private readonly killGraceMs: number;
  private readonly subscriptions: PtyDisposable[];
  private status: TerminalStatus = { state: 'running' };
  private seq = 0;
  private backlog = 0;
  private paused = false;
  private muted = false;
  private killing: Promise<void> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly exitWaiters: Array<() => void> = [];

  constructor(options: SessionOptions) {
    this.chatId = options.chatId;
    this.pty = options.pty;
    this.screen = options.screen;
    this.shell = options.shell;
    this.cwd = options.cwd;
    this.events = options.events;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.subscriptions = [
      this.pty.onData((data) => this.handleData(data)),
      this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal ?? null)),
    ];
  }

  get pid(): number {
    return this.pty.pid;
  }

  get running(): boolean {
    return this.status.state === 'running';
  }

  /** The sequence number of the last data event sent. */
  get lastSeq(): number {
    return this.seq;
  }

  info(): TerminalInfo {
    return {
      chatId: this.chatId,
      shell: this.shell,
      cwd: this.cwd,
      cols: this.screen.cols,
      rows: this.screen.rows,
      status: { ...this.status },
    };
  }

  write(data: string): void {
    if (!this.running || data.length === 0) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.screen.cols && rows === this.screen.rows) return;
    if (this.running) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // The PTY can close between the exit and our status update; the screen still resizes.
      }
    }
    this.screen.resize(cols, rows);
  }

  /** The serialized screen and the `seq` it is current to. Rejects if the session is disposed while waiting. */
  snapshot(): Promise<{ snapshot: string; seq: number; info: TerminalInfo }> {
    // Every event up to `seq` was written to the screen before this marker, and every later one after it.
    const seq = this.seq;
    return this.screen.afterParsed(() => ({ snapshot: this.screen.serialize(), seq, info: this.info() }));
  }

  /** The requested range, once pending output has been parsed. Rejects if the session is disposed while waiting. */
  read(request: TerminalReadRequest): Promise<TerminalReadResult> {
    return this.screen.afterParsed(() => ({ info: this.info(), ...this.screen.read(request) }));
  }

  /** Stops data and exit events (the session has been forgotten; a new one may already use the chat id). */
  mute(): void {
    this.muted = true;
  }

  /**
   * Ends the shell: SIGHUP, then SIGKILL after `killGraceMs` if it is still running. Resolves when it has exited, or
   * `killGraceMs` after the SIGKILL if no exit was reported.
   */
  kill(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.killing) return this.killing;
    this.killing = new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve);
      this.signal('SIGHUP');
      this.killTimer = setTimeout(() => {
        if (!this.running) return;
        this.signal('SIGKILL');
        this.killTimer = setTimeout(() => this.settleKill(), this.killGraceMs);
      }, this.killGraceMs);
    });
    return this.killing;
  }

  /** SIGKILL now, synchronously, if the shell is still running. For process exit, when nothing can wait. */
  killNow(): void {
    if (this.running) this.signal('SIGKILL');
  }

  /** Mutes, kills and frees the screen. Resolves when the shell has gone (see `kill`). */
  dispose(): Promise<void> {
    this.mute();
    const killed = this.kill();
    // Rejects pending snapshot and read waits, so no IPC call is left hanging.
    this.screen.dispose();
    return killed.finally(() => {
      for (const subscription of this.subscriptions) subscription.dispose();
    });
  }

  private signal(signal: 'SIGHUP' | 'SIGKILL'): void {
    try {
      this.pty.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private settleKill(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    for (const resolve of this.exitWaiters.splice(0)) resolve();
  }

  private handleData(data: string): void {
    this.seq += 1;
    const seq = this.seq;
    this.backlog += data.length;
    this.screen.write(data, () => {
      this.backlog -= data.length;
      if (this.paused && this.backlog <= BACKLOG_LOW) {
        this.paused = false;
        this.pty.resume();
      }
    });
    if (!this.paused && this.running && this.backlog > BACKLOG_HIGH) {
      this.paused = true;
      this.pty.pause();
    }
    if (!this.muted) this.events.data({ chatId: this.chatId, seq, data });
  }

  private handleExit(exitCode: number, signal: number | null): void {
    if (!this.running) return;
    // node-pty reports a signal death as code 0 plus the signal; report no code then.
    this.status = { state: 'exited', exitCode: signal ? null : exitCode, signal: signal || null };
    if (this.paused) {
      this.paused = false;
      this.pty.resume();
    }
    // The plan (T1.2) has the PTY killed on exit so node-pty releases its descriptor. On macOS node-pty 1.1.0 closes
    // the session's master itself and this changes nothing (measured); kept for Linux, where it is unverified.
    try {
      this.pty.kill();
    } catch {
      // Already gone.
    }
    this.settleKill();
    if (!this.muted) this.events.exit({ chatId: this.chatId, status: { ...this.status } });
  }
}
