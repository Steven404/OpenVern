// One terminal session: a PTY running the shell plus the headless screen its output is written into (plan T1.2).
// Output passes through an OutputFilter (./output-filter.ts), then goes to the screen and out as data events with a
// sequence number that increases by one per event, so a reattaching renderer can tell which events its snapshot
// already holds. Every event ends with xterm's parser at rest, so every snapshot does too.

import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalStatus,
} from '@shared/terminal';
import { TERMINAL } from '@shared/terminal';
import type { Id } from '@shared/types';
import { OutputFilter, type OutputFilterOptions } from './output-filter';
import { type KillSignal, SessionProcesses, type SignalProcess, signalProcess } from './processes';
import type { PtyDisposable, PtyProcess } from './pty';
import type { TerminalScreen } from './screen';

/**
 * How long the processes get after SIGHUP before SIGKILL, and how long the shell then gets to report its exit before
 * the kill gives up waiting.
 */
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
  /** The processes in the shell's session. Default: none known, so only the shell is signalled. */
  processes?: SessionProcesses;
  /** How processes other than the shell are signalled. Default: `process.kill`. */
  signal?: SignalProcess;
  /** Bytes of input that may wait for the shell to read them. Default: `TERMINAL.pendingInputMaxBytes`. */
  pendingInputMaxBytes?: number;
  filter?: OutputFilterOptions;
  log?: (message: string) => void;
}

export class TerminalSession {
  readonly chatId: Id;
  private readonly pty: PtyProcess;
  private readonly screen: TerminalScreen;
  private readonly shell: string;
  private readonly cwd: string;
  private readonly events: SessionEvents;
  private readonly killGraceMs: number;
  private readonly processes: SessionProcesses;
  private readonly signal: SignalProcess;
  private readonly pendingInputMax: number;
  private readonly filter: OutputFilter;
  private readonly log: (message: string) => void;
  private readonly dataSubscription: PtyDisposable;
  private readonly exitSubscription: PtyDisposable;
  private status: TerminalStatus = { state: 'running' };
  private seq = 0;
  private backlog = 0;
  private paused = false;
  private muted = false;
  /** One warning per stretch of dropped input, and one if the queue cannot be measured. */
  private inputDropWarned = false;
  private inputUnmeasuredWarned = false;
  private killing: Promise<void> | null = null;
  /** The lookup made when the shell exited, which records what it left behind (Linux). */
  private exitLookup: Promise<void> = Promise.resolve();
  private readonly exitWaiters = new Set<() => void>();
  private resolveExited!: () => void;
  /** Resolves once node-pty has reported the shell's exit. */
  readonly exited: Promise<void> = new Promise((resolve) => {
    this.resolveExited = resolve;
  });

  constructor(options: SessionOptions) {
    this.chatId = options.chatId;
    this.pty = options.pty;
    this.screen = options.screen;
    this.shell = options.shell;
    this.cwd = options.cwd;
    this.events = options.events;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.processes = options.processes ?? new SessionProcesses(options.pty.pid, null);
    this.signal = options.signal ?? signalProcess;
    this.pendingInputMax = options.pendingInputMaxBytes ?? TERMINAL.pendingInputMaxBytes;
    this.filter = new OutputFilter(options.filter);
    this.log = options.log ?? console.warn;
    this.dataSubscription = this.pty.onData((data) => this.handleData(data));
    this.exitSubscription = this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal ?? null));
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

  /**
   * Passes input to the shell, unless more than `pendingInputMaxBytes` would then be waiting for it to read (a shell
   * that is not reading, e.g. stopped with Ctrl+S, or a huge paste): that write is dropped whole.
   */
  write(data: string): void {
    if (!this.running || data.length === 0) return;
    const pending = this.pty.pendingInputBytes?.();
    if (pending === null) {
      if (!this.inputUnmeasuredWarned) {
        this.inputUnmeasuredWarned = true;
        this.log('[openvern] terminal: cannot measure queued input (node-pty internals changed); input is not bounded');
      }
    } else if (pending !== undefined && pending + Buffer.byteLength(data, 'utf8') > this.pendingInputMax) {
      if (!this.inputDropWarned) {
        this.inputDropWarned = true;
        this.log(
          `[openvern] terminal: the shell is not reading its input; dropping input beyond ${this.pendingInputMax} bytes`,
        );
      }
      return;
    }
    this.inputDropWarned = false;
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
   * Ends the shell and every process still in its session (plan §2, "Ending a terminal"): SIGHUP to all of them, then,
   * after `killGraceMs`, SIGKILL to those that remain, whether or not the shell is still there. When the shell was
   * the only process, it resolves as soon as the shell exits. Otherwise it resolves after the SIGKILL, once the shell
   * has reported its exit or another `killGraceMs` has passed. Also sweeps a session whose shell already exited.
   */
  kill(): Promise<void> {
    this.killing ??= this.endProcesses();
    return this.killing;
  }

  /** SIGKILL now, synchronously, to the shell and its session. For process exit, when nothing can wait. */
  killNow(): void {
    const others = this.processes.members(this.processes.snapshotSync());
    if (this.running) this.signalShell('SIGKILL');
    for (const entry of others) this.signal(entry.pid, 'SIGKILL');
  }

  /** Resolves once the kill has finished and the shell has exited: until then the session still holds a process. */
  whenGone(): Promise<void> {
    return Promise.all([this.kill(), this.exited]).then(() => undefined);
  }

  /** Mutes, kills and frees the screen. Resolves when the kill has finished (see `kill`). */
  dispose(): Promise<void> {
    this.mute();
    const killed = this.kill();
    // Rejects pending snapshot and read waits, so no IPC call is left hanging.
    this.screen.dispose();
    void this.exited.then(() => this.exitSubscription.dispose());
    return killed.finally(() => this.dataSubscription.dispose());
  }

  private async endProcesses(): Promise<void> {
    await this.exitLookup;
    // Look before signalling: on macOS the session's processes can only be told apart while the shell is alive.
    const first = this.processes.members(await this.processes.snapshot());
    if (!this.running && first.length === 0) return;
    if (this.running) this.signalShell('SIGHUP');
    for (const entry of first) this.signal(entry.pid, 'SIGHUP');
    if (first.length === 0) {
      if (await this.waitForExit(this.killGraceMs)) return;
    } else {
      await delay(this.killGraceMs);
    }
    // Look again right before SIGKILL: only processes that are still the ones seen (pid and start time) get it.
    const second = this.processes.members(await this.processes.snapshot());
    if (this.running) this.signalShell('SIGKILL');
    for (const entry of second) this.signal(entry.pid, 'SIGKILL');
    if (this.running) await this.waitForExit(this.killGraceMs);
  }

  /** Resolves true when the shell exits within `ms`, false otherwise. */
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

  /** Signals the shell through node-pty. Only while it has not reported the exit, so never a reaped pid. */
  private signalShell(signal: KillSignal): void {
    if (!this.running) return;
    try {
      this.pty.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private handleData(data: string): void {
    this.emit(this.filter.push(data));
  }

  private emit(data: string): void {
    if (data.length === 0) return;
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
    // Delivery to the renderer is not flow-controlled: a renderer that falls behind is not waited for. Acknowledgement
    // based flow control (the renderer confirming what it has drawn, main pausing the PTY) would go here; it is out of
    // scope for now (T1 review decision).
    if (!this.muted) this.events.data({ chatId: this.chatId, seq, data });
  }

  private handleExit(exitCode: number, signal: number | null): void {
    if (!this.running) return;
    // The shell is gone: nothing will complete a sequence it left open.
    this.emit(this.filter.flush());
    // node-pty reports a signal death as code 0 plus the signal; report no code then.
    this.status = { state: 'exited', exitCode: signal ? null : exitCode, signal: signal || null };
    if (this.paused) {
      this.paused = false;
      this.pty.resume();
    }
    // node-pty has reaped the shell, so its pid may be reused from here on: nothing signals it again. (node-pty 1.1.0's
    // kill() is only process.kill(pid) and frees nothing.)
    this.processes.leaderGone();
    // Record what the shell left in its session while that can still be told (Linux; see ./processes.ts).
    this.exitLookup = this.processes.snapshot().then((snapshot) => {
      this.processes.members(snapshot, { justExited: true });
    });
    for (const resolve of [...this.exitWaiters]) resolve();
    this.resolveExited();
    if (!this.muted) this.events.exit({ chatId: this.chatId, status: { ...this.status } });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
