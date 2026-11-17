// One terminal session (docs/terminal-plan.md T1.2, T1.4): a PTY running the shell and a bounded copy of its raw
// output for replay. Output is never interpreted here: each chunk goes out unmodified as a data event, with a `seq`
// that increases by one per event, and into the replay buffer. Both happen in the same synchronous step, so the
// replay and the `seq` read together always agree: the replay holds every event up to that `seq` and none after.

import type { TerminalDataEvent, TerminalExitEvent, TerminalInfo, TerminalStatus } from '@shared/terminal';
import { TERMINAL } from '@shared/terminal';
import type { Id } from '@shared/types';
import type { IsOwnChild } from './own-child';
import type { PtyDisposable, PtyProcess } from './pty';
import { ReplayBuffer } from './replay-buffer';

/** How long the shell gets after SIGHUP before SIGKILL, and after SIGKILL before the end stops waiting for it. */
export const KILL_GRACE_MS = 1_000;

/** Shown in the terminal when input is refused because the queue waiting for the shell cannot be measured. */
export const INPUT_UNMEASURABLE_NOTICE =
  '\r\n[OpenVern] This terminal no longer accepts input: OpenVern cannot tell how much input is waiting for the ' +
  'shell, so it cannot keep that input bounded. Output still shows. Open a new terminal after updating OpenVern.\r\n';
/** Shown once per stretch of dropped input, so a paste that was cut short is not a silent loss. */
export const INPUT_DROPPED_NOTICE =
  '\r\n[OpenVern] The shell is not reading fast enough, so part of what was typed or pasted was dropped.\r\n';

export interface SessionEvents {
  data(event: TerminalDataEvent): void;
  exit(event: TerminalExitEvent): void;
}

export interface SessionOptions {
  chatId: Id;
  pty: PtyProcess;
  /** Basename of the shell, e.g. `zsh`. */
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  events: SessionEvents;
  /** Checked right before every signal to the shell's pid; false skips the signal. */
  isOwnChild: IsOwnChild;
  killGraceMs?: number;
  /** Bytes of input that may wait for the shell to read them. Default: `TERMINAL.pendingInputMaxBytes`. */
  pendingInputMaxBytes?: number;
  /** Raw output kept for replay. Default: `TERMINAL.replayMaxBytes`. */
  replayMaxBytes?: number;
  log?: (message: string) => void;
}

export interface SessionReplay {
  replay: string;
  replayTruncated: boolean;
  seq: number;
}

export class TerminalSession {
  /** Changes only through `rekey`, when the New Chat screen's session moves to its chat. */
  private id: Id;
  private readonly pty: PtyProcess;
  private readonly shell: string;
  private readonly cwd: string;
  private cols: number;
  private rows: number;
  private readonly events: SessionEvents;
  private readonly isOwnChild: IsOwnChild;
  private readonly killGraceMs: number;
  private readonly pendingInputMax: number;
  private readonly log: (message: string) => void;
  private readonly buffer: ReplayBuffer;
  private readonly subscriptions: PtyDisposable[];
  private status: TerminalStatus = { state: 'running' };
  private seq = 0;
  private muted = false;
  /** End has begun: no more input or resizes reach the PTY. */
  private endStarted = false;
  private ending: Promise<void> | null = null;
  private ptyClosed = false;
  /** One log line per stretch of dropped input. */
  private inputDropWarned = false;
  /** The queued input could not be measured once: input stays refused for the rest of the session. */
  private inputRefused = false;
  private readonly exitWaiters = new Set<() => void>();
  private resolveExited!: () => void;
  /** Resolves once node-pty has reported the shell's exit. */
  readonly exited: Promise<void> = new Promise((resolve) => {
    this.resolveExited = resolve;
  });

  constructor(options: SessionOptions) {
    this.id = options.chatId;
    this.pty = options.pty;
    this.shell = options.shell;
    this.cwd = options.cwd;
    this.cols = options.cols;
    this.rows = options.rows;
    this.events = options.events;
    this.isOwnChild = options.isOwnChild;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.pendingInputMax = options.pendingInputMaxBytes ?? TERMINAL.pendingInputMaxBytes;
    this.log = options.log ?? console.warn;
    this.buffer = new ReplayBuffer(options.replayMaxBytes ?? TERMINAL.replayMaxBytes);
    this.subscriptions = [
      this.pty.onData((data) => this.output(data)),
      this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal ?? null)),
    ];
  }

  /** The chat the session belongs to. Every data and exit event, and `info()`, carry it. */
  get chatId(): Id {
    return this.id;
  }

  /**
   * Files the session under another chat (the manager moving the New Chat screen's session to its chat). Events
   * sent from here on carry the new id; the replay, `seq` and the shell are unchanged.
   */
  rekey(chatId: Id): void {
    this.id = chatId;
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Until node-pty reports the exit. A shell that is being ended is still running. */
  get running(): boolean {
    return this.status.state === 'running';
  }

  /** The `seq` of the last data event sent. */
  get lastSeq(): number {
    return this.seq;
  }

  info(): TerminalInfo {
    return {
      chatId: this.chatId,
      shell: this.shell,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      status: { ...this.status },
    };
  }

  /** The raw output kept so far and the `seq` of the last event in it. Synchronous, so the two always agree. */
  replay(): SessionReplay {
    const { text, truncated } = this.buffer.snapshot();
    return { replay: text, replayTruncated: truncated, seq: this.seq };
  }

  /** Drops the kept output (the renderer crashed); the shell keeps running and new output is kept again. */
  clearReplay(): void {
    this.buffer.clear();
  }

  /**
   * Passes input to the shell, unless more than `pendingInputMaxBytes` would then be waiting for it to read (a shell
   * that is not reading, e.g. stopped with Ctrl+S, or a huge paste): that write is dropped whole. When the waiting
   * input cannot be measured, input is refused for good and the terminal says why (failing closed).
   */
  write(data: string): void {
    if (!this.running || this.endStarted || this.inputRefused || data.length === 0) return;
    const pending = this.pendingInput();
    if (pending === null) {
      this.inputRefused = true;
      this.log(
        '[openvern] terminal: cannot measure the input waiting for the shell; input to this terminal is refused',
      );
      this.output(INPUT_UNMEASURABLE_NOTICE);
      return;
    }
    if (pending + Buffer.byteLength(data, 'utf8') > this.pendingInputMax) {
      if (!this.inputDropWarned) {
        this.inputDropWarned = true;
        this.log(
          `[openvern] terminal: the shell is not reading its input; dropping input beyond ${this.pendingInputMax} bytes`,
        );
        this.output(INPUT_DROPPED_NOTICE);
      }
      return;
    }
    this.inputDropWarned = false;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    if (!this.running || this.endStarted) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // The PTY can close between the shell's exit and its report.
    }
  }

  /** Stops data and exit events and frees the kept output (the session has been forgotten). */
  mute(): void {
    this.muted = true;
    this.buffer.clear();
  }

  /**
   * Ends the shell (plan §2, "Ending a terminal"): SIGHUP; if the shell has not exited after `killGraceMs`, close the
   * terminal device (which hangs up its foreground job too) and SIGKILL it. Only the shell is signalled, never once
   * its exit has been reported, and only after checking that its pid is still a child of this process. Resolves once
   * the exit has been reported, or `killGraceMs` after the SIGKILL step. Idempotent.
   *
   * The device is closed only after the grace period, not together with the SIGHUP: closing it makes the kernel send
   * the shell a second SIGHUP, and bash, getting it while it is still handling the first, dies at once without
   * passing the hang-up on to its jobs, so a plain `sleep 100 &` would outlive the terminal (seen with bash 3.2 on
   * macOS; zsh is not affected). A shell that exits on the SIGHUP needs no close: node-pty closes the device itself.
   */
  end(): Promise<void> {
    this.ending ??= this.runEnd();
    return this.ending;
  }

  /** SIGKILL now, synchronously, if the shell is still ours. For process exit, when nothing can wait. */
  killNow(): void {
    this.signal('SIGKILL');
  }

  private async runEnd(): Promise<void> {
    this.endStarted = true;
    if (!this.running) return;
    // Not our child any more: the device's hang-up is the only one left to give.
    if (!this.signal('SIGHUP')) this.closePty();
    if (await this.waitForExit(this.killGraceMs)) return;
    this.closePty();
    this.signal('SIGKILL');
    await this.waitForExit(this.killGraceMs);
  }

  private closePty(): void {
    if (this.ptyClosed) return;
    this.ptyClosed = true;
    try {
      this.pty.close();
    } catch {
      // Already closed.
    }
  }

  /** Resolves true when the shell's exit is reported within `ms`, false otherwise. */
  private waitForExit(ms: number): Promise<boolean> {
    if (!this.running) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (exited: boolean) => {
        clearTimeout(timer);
        this.exitWaiters.delete(onExit);
        resolve(exited);
      };
      const onExit = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      this.exitWaiters.add(onExit);
    });
  }

  /**
   * Signals the shell's pid, only while its exit has not been reported and only when the pid is still our child
   * (checked right before, with nothing in between that could let the exit report run). True when it was sent.
   */
  private signal(signal: 'SIGHUP' | 'SIGKILL'): boolean {
    if (!this.running) return false;
    if (!this.isOwnChild(this.pty.pid)) {
      this.log(`[openvern] terminal: pid ${this.pty.pid} is no longer this app's child; ${signal} not sent`);
      return false;
    }
    try {
      this.pty.kill(signal);
      return true;
    } catch {
      return false; // Already gone.
    }
  }

  /** Shell output (or a notice of ours): into the replay buffer and out as the next data event, unmodified. */
  private output(data: string): void {
    if (data.length === 0 || this.muted) return;
    this.seq += 1;
    this.buffer.append(data);
    // Delivery is not flow-controlled: a renderer that falls behind is not waited for. Acknowledgement-based flow
    // control (the renderer confirming how much it has written into its emulator, main calling pause() on the PTY
    // while too much is unconfirmed and resume() once it catches up) would go here. Deferred by decision.
    this.events.data({ chatId: this.chatId, seq: this.seq, data });
  }

  private handleExit(exitCode: number, signal: number | null): void {
    if (!this.running) return;
    // node-pty reports a signal death as code 0 plus the signal; report no code then.
    this.status = { state: 'exited', exitCode: signal ? null : exitCode, signal: signal || null };
    // node-pty has reaped the shell, so its pid may be reused from here on: nothing signals it again (see `signal`).
    // node-pty emits the exit only after its read side has closed, so no output follows.
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const resolve of [...this.exitWaiters]) resolve();
    this.resolveExited();
    if (!this.muted) this.events.exit({ chatId: this.chatId, status: { ...this.status } });
  }

  private pendingInput(): number | null {
    let value: unknown;
    try {
      value = this.pty.pendingInputBytes();
    } catch {
      return null;
    }
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
}
