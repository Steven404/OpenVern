// Terminal sessions by chat id (plan T1.3, T1.4). Inputs here are already validated (./validate.ts); the PTY, the
// shell, the file system and where events go are injected, so tests can run it with a fake PTY.

import { basename, isAbsolute, resolve } from 'node:path';
import { TERMINAL, type TerminalOpenResult, type TerminalReadAnswer, type TerminalReadRequest } from '@shared/terminal';
import type { Id } from '@shared/types';
import { type ProcessTable, SessionProcesses, type SignalProcess } from './processes';
import type { PtyProcess, SpawnPty } from './pty';
import { TerminalScreen } from './screen';
import { type SessionEvents, TerminalSession } from './session';

export interface ShellCommand {
  /** Absolute path of the shell. */
  file: string;
  args: readonly string[];
  env: Record<string, string>;
}

export interface TerminalManagerDeps {
  spawn: SpawnPty;
  /** Resolved on every new session, so a changed environment is picked up. */
  shell: () => ShellCommand;
  homeDir: () => string;
  /** Whether the path is an existing directory. Must not throw. */
  isDirectory: (path: string) => boolean;
  events: SessionEvents;
  /** Finds the processes in each shell's session. Null or omitted: only the shells themselves are signalled. */
  processTable?: ProcessTable | null;
  /** How those processes are signalled. Default: `process.kill`. */
  signal?: SignalProcess;
  killGraceMs?: number;
  maxSessions?: number;
  maxSpawnsPerRun?: number;
  pendingInputMaxBytes?: number;
  scrollbackLines?: number;
  log?: (message: string) => void;
}

export interface OpenParams {
  chatId: Id;
  /** null = the home folder. */
  cwd: string | null;
  cols: number;
  rows: number;
  /** Replace an exited session with a fresh shell (Restart). Ignored while the shell is running. */
  restart?: boolean;
}

export class TerminalLimitError extends Error {
  constructor(max: number) {
    super(`At most ${max} terminals can run at once, counting any that are still closing. End one to open another.`);
    this.name = 'TerminalLimitError';
  }
}

/** node-pty 1.1.0 leaks descriptors on every spawn on macOS, freed only when the app exits (plan §2, "Limits"). */
export class TerminalSpawnLimitError extends Error {
  constructor(max: number) {
    super(
      `OpenVern has started ${max} terminals since it was opened, the most it can start in one run. Restart OpenVern to open more terminals.`,
    );
    this.name = 'TerminalSpawnLimitError';
  }
}

export class TerminalShutdownError extends Error {
  constructor() {
    super('OpenVern is closing its terminals, so a new one cannot be opened now.');
    this.name = 'TerminalShutdownError';
  }
}

export class TerminalManager {
  private readonly sessions = new Map<Id, TerminalSession>();
  /** Forgotten sessions whose kill has not finished or whose shell has not yet reported its exit. */
  private readonly dying = new Set<TerminalSession>();
  private readonly maxSessions: number;
  private readonly maxSpawns: number;
  /** Shells started in this app run (see `TerminalSpawnLimitError`). */
  private spawned = 0;
  private shuttingDown = false;

  constructor(private readonly deps: TerminalManagerDeps) {
    this.maxSessions = deps.maxSessions ?? TERMINAL.maxSessions;
    this.maxSpawns = deps.maxSpawnsPerRun ?? TERMINAL.maxSpawnsPerRun;
  }

  /** Sessions by chat id, running or exited. */
  get size(): number {
    return this.sessions.size;
  }

  /** What counts against `maxSessions`: every session by chat id, plus forgotten ones whose shell is still running. */
  get liveCount(): number {
    let count = this.sessions.size;
    for (const session of this.dying) if (session.running) count += 1;
    return count;
  }

  /** Shells started so far in this app run. */
  get spawnCount(): number {
    return this.spawned;
  }

  /** Quit or window close has begun: `open` refuses until `endShutdown` (a quit that was cancelled). */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  endShutdown(): void {
    this.shuttingDown = false;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  has(chatId: Id): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Attaches to the chat's session, running or exited (its snapshot and `seq`; the requested size is ignored, `info`
   * carries the session's), or starts a new one. With `restart`, an exited session is replaced by a fresh shell.
   * Throws `TerminalShutdownError` during shutdown, `TerminalSpawnLimitError` once `maxSpawnsPerRun` shells have been
   * started, `TerminalLimitError` at `maxSessions`, and whatever the spawn throws.
   */
  async open(params: OpenParams): Promise<TerminalOpenResult> {
    if (this.shuttingDown) throw new TerminalShutdownError();
    const existing = this.sessions.get(params.chatId);
    if (existing && (existing.running || params.restart !== true)) {
      const { snapshot, seq, info } = await existing.snapshot();
      return { info, snapshot, seq, created: false };
    }
    // Synchronous from here to the map insert, so two opens for one chat can't both create.
    if (this.spawned >= this.maxSpawns) throw new TerminalSpawnLimitError(this.maxSpawns);
    // Room first: a refused restart keeps the exited session (and its scrollback).
    this.makeRoom(existing);
    if (existing) this.forget(existing);
    const session = this.create(params);
    this.sessions.set(params.chatId, session);
    return { info: session.info(), snapshot: '', seq: 0, created: true };
  }

  write(chatId: Id, data: string): void {
    this.sessions.get(chatId)?.write(data);
  }

  resize(chatId: Id, cols: number, rows: number): void {
    this.sessions.get(chatId)?.resize(cols, rows);
  }

  /** Reads a running or exited session. `no_terminal` when the chat has none (or it is closed while reading). */
  async read(chatId: Id, request: TerminalReadRequest): Promise<TerminalReadAnswer> {
    const session = this.sessions.get(chatId);
    if (!session) return { ok: false, reason: 'no_terminal' };
    try {
      return { ok: true, result: await session.read(request) };
    } catch {
      return { ok: false, reason: 'no_terminal' };
    }
  }

  /**
   * Ends the session's processes and forgets it. Resolves at once; they finish dying in the background, and a shell
   * still running counts against `maxSessions` until it has exited.
   */
  async close(chatId: Id): Promise<void> {
    const session = this.sessions.get(chatId);
    if (session) this.forget(session);
  }

  /** Forgets every session and resolves once all their kills have finished (SIGKILL after the grace period). */
  async disposeAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) this.forget(session);
    await Promise.all([...this.dying].map((session) => session.kill()));
  }

  /** SIGKILL to every session's processes. Synchronous, for `process.on('exit')`. */
  killAllNow(): void {
    for (const session of this.sessions.values()) session.killNow();
    for (const session of this.dying) session.killNow();
  }

  private forget(session: TerminalSession): void {
    if (this.sessions.get(session.chatId) === session) this.sessions.delete(session.chatId);
    this.dying.add(session);
    void session.dispose();
    void session.whenGone().then(() => this.dying.delete(session));
  }

  /**
   * At the limit, drops the oldest exited session (kept only for reads); refuses when that does not make room.
   * `replacing` is an exited session the caller is about to forget, so its slot counts as free.
   */
  private makeRoom(replacing?: TerminalSession): void {
    const used = () => this.liveCount - (replacing ? 1 : 0);
    if (used() < this.maxSessions) return;
    for (const session of this.sessions.values()) {
      if (!session.running && session !== replacing) {
        this.forget(session);
        break;
      }
    }
    if (used() >= this.maxSessions) throw new TerminalLimitError(this.maxSessions);
  }

  private create(params: OpenParams): TerminalSession {
    const cwd = this.resolveCwd(params.cwd);
    const shell = this.deps.shell();
    const screen = new TerminalScreen(params.cols, params.rows, this.deps.scrollbackLines ?? TERMINAL.scrollbackLines);
    let pty: PtyProcess;
    // Counted before the call: a spawn that fails in native code may leak as well.
    this.spawned += 1;
    try {
      pty = this.deps.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: params.cols,
        rows: params.rows,
        cwd,
        env: shell.env,
      });
    } catch (err) {
      screen.dispose();
      throw err;
    }
    return new TerminalSession({
      chatId: params.chatId,
      pty,
      screen,
      shell: basename(shell.file),
      cwd,
      events: this.deps.events,
      killGraceMs: this.deps.killGraceMs,
      processes: new SessionProcesses(pty.pid, this.deps.processTable ?? null),
      signal: this.deps.signal,
      pendingInputMaxBytes: this.deps.pendingInputMaxBytes,
      log: this.deps.log,
    });
  }

  /** The requested folder when it is an absolute path to an existing directory, else home. */
  private resolveCwd(requested: string | null): string {
    if (requested !== null && isAbsolute(requested)) {
      const path = resolve(requested);
      if (this.deps.isDirectory(path)) return path;
    }
    return this.deps.homeDir();
  }
}
