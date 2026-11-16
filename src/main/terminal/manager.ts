// Terminal sessions by chat id (plan T1.3, T1.4). Inputs here are already validated (./validate.ts); the PTY, the
// shell, the file system, the own-child check and where events go are injected, so tests run it with a fake PTY.

import { basename, isAbsolute, resolve } from 'node:path';
import { TERMINAL, type TerminalDefaultFolder, type TerminalInfo, type TerminalOpenResult } from '@shared/terminal';
import type { Id } from '@shared/types';
import type { IsOwnChild } from './own-child';
import type { PtyProcess, SpawnPty } from './pty';
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
  /** The user's Documents folder, or null when it cannot be found. Must not throw (a throw is treated as null). */
  documentsDir: () => string | null;
  /** Whether the path is an existing directory. Must not throw. */
  isDirectory: (path: string) => boolean;
  events: SessionEvents;
  /** Whether a pid is still a child of this process; checked right before every signal to a shell. */
  isOwnChild: IsOwnChild;
  killGraceMs?: number;
  maxSessions?: number;
  maxSpawnsPerRun?: number;
  pendingInputMaxBytes?: number;
  replayMaxBytes?: number;
  log?: (message: string) => void;
}

export interface OpenParams {
  chatId: Id;
  /** null = `defaultFolder`. */
  cwd: string | null;
  /** Where a null `cwd` starts: Documents (home when missing). Absent = home. Never set with a string `cwd`. */
  defaultFolder?: Exclude<TerminalDefaultFolder, 'home'>;
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
  /** Forgotten sessions whose shell has not yet reported its exit. They still count against `maxSessions`. */
  private readonly dying = new Set<TerminalSession>();
  private readonly maxSessions: number;
  private readonly maxSpawns: number;
  /** Spawn attempts in this app run, failed ones included (see `TerminalSpawnLimitError`). */
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

  /** What counts against `maxSessions`: every session by chat id, plus forgotten ones whose exit is not reported. */
  get liveCount(): number {
    return this.sessions.size + this.dying.size;
  }

  /** Spawn attempts so far in this app run. */
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

  /** The info of every session held, running or exited, oldest first. */
  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((session) => session.info());
  }

  /**
   * Attaches to the chat's session, running or exited (its replay and `seq`; the requested size is ignored, `info`
   * carries the session's), or starts a new one. With `restart`, an exited session is replaced by a fresh shell.
   * Throws `TerminalShutdownError` during shutdown, `TerminalSpawnLimitError` once `maxSpawnsPerRun` spawns have been
   * attempted, `TerminalLimitError` at `maxSessions`, and whatever the spawn throws. Synchronous throughout, so no
   * output can arrive between reading the replay and its `seq`, and two opens for one chat can't both create.
   */
  async open(params: OpenParams): Promise<TerminalOpenResult> {
    if (this.shuttingDown) throw new TerminalShutdownError();
    const existing = this.sessions.get(params.chatId);
    if (existing && (existing.running || params.restart !== true)) {
      return { info: existing.info(), ...existing.replay(), created: false };
    }
    if (this.spawned >= this.maxSpawns) throw new TerminalSpawnLimitError(this.maxSpawns);
    // Room first: a refused restart keeps the exited session (and its replay).
    this.makeRoom(existing);
    const session = this.create(params);
    if (existing) void this.forget(existing);
    this.sessions.set(params.chatId, session);
    return { info: session.info(), replay: '', replayTruncated: false, seq: 0, created: true };
  }

  /**
   * Moves the session held under `from` to `to` (the New Chat screen's terminal joining the chat created from it): the
   * same shell, replay and `seq`, and later events carry `to`. False, with nothing changed, when `from` has no session
   * or `to` already has one. Never spawns and never ends a shell, so the session limit and the spawn count are
   * unaffected. Synchronous, so no event can go out between the move and the rename. Callers check that `from` is
   * the draft id (./validate.ts `parseAdopt`).
   */
  adopt(from: Id, to: Id): boolean {
    if (from === to) return false;
    const session = this.sessions.get(from);
    if (!session || this.sessions.has(to)) return false;
    this.sessions.delete(from);
    session.rekey(to);
    this.sessions.set(to, session);
    return true;
  }

  write(chatId: Id, data: string): void {
    this.sessions.get(chatId)?.write(data);
  }

  resize(chatId: Id, cols: number, rows: number): void {
    this.sessions.get(chatId)?.resize(cols, rows);
  }

  /**
   * Forgets the session and ends its shell. Resolves once the shell's exit is reported, or after the grace period
   * that follows the SIGKILL. The shell counts against `maxSessions` until its exit is reported.
   */
  async close(chatId: Id): Promise<void> {
    const session = this.sessions.get(chatId);
    if (session) await this.forget(session);
  }

  /** Forgets every session and resolves once every shell being ended has exited or been given up on. */
  async disposeAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) void this.forget(session);
    await Promise.all([...this.dying].map((session) => session.end()));
  }

  /** The renderer crashed: drop every session's kept output, so it can't be replayed into the next one. */
  clearReplays(): void {
    for (const session of this.sessions.values()) session.clearReplay();
  }

  /** SIGKILL to every shell still ours. Synchronous, for `process.on('exit')`. */
  killAllNow(): void {
    for (const session of this.sessions.values()) session.killNow();
    for (const session of this.dying) session.killNow();
  }

  private forget(session: TerminalSession): Promise<void> {
    if (this.sessions.get(session.chatId) === session) this.sessions.delete(session.chatId);
    session.mute();
    if (session.running) {
      this.dying.add(session);
      void session.exited.then(() => this.dying.delete(session));
    }
    return session.end();
  }

  /**
   * At the limit, drops the oldest exited session; refuses when that does not make room. `replacing` is an exited
   * session the caller is about to forget, so its slot counts as free.
   */
  private makeRoom(replacing?: TerminalSession): void {
    const used = () => this.liveCount - (replacing ? 1 : 0);
    if (used() < this.maxSessions) return;
    for (const session of this.sessions.values()) {
      if (!session.running && session !== replacing) {
        void this.forget(session);
        break;
      }
    }
    if (used() >= this.maxSessions) throw new TerminalLimitError(this.maxSessions);
  }

  private create(params: OpenParams): TerminalSession {
    const cwd = this.resolveCwd(params.cwd, params.defaultFolder);
    const shell = this.deps.shell();
    // Counted before the call: a spawn that fails in native code may leak as well.
    this.spawned += 1;
    const pty: PtyProcess = this.deps.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: params.cols,
      rows: params.rows,
      cwd,
      env: shell.env,
    });
    return new TerminalSession({
      chatId: params.chatId,
      pty,
      shell: basename(shell.file),
      cwd,
      cols: params.cols,
      rows: params.rows,
      events: this.deps.events,
      isOwnChild: this.deps.isOwnChild,
      killGraceMs: this.deps.killGraceMs,
      pendingInputMaxBytes: this.deps.pendingInputMaxBytes,
      replayMaxBytes: this.deps.replayMaxBytes,
      log: this.deps.log,
    });
  }

  /**
   * The requested folder when it is an absolute path to an existing directory, else home. With no folder requested,
   * Documents when asked for and it is an absolute path to an existing directory, else home.
   */
  private resolveCwd(requested: string | null, defaultFolder: OpenParams['defaultFolder']): string {
    if (requested !== null) {
      if (isAbsolute(requested)) {
        const path = resolve(requested);
        if (this.deps.isDirectory(path)) return path;
      }
      return this.deps.homeDir();
    }
    if (defaultFolder === 'documents') {
      const documents = this.documentsDir();
      if (documents !== null && isAbsolute(documents)) {
        const path = resolve(documents);
        if (this.deps.isDirectory(path)) return path;
      }
    }
    return this.deps.homeDir();
  }

  private documentsDir(): string | null {
    try {
      const dir = this.deps.documentsDir();
      return typeof dir === 'string' && dir.length > 0 ? dir : null;
    } catch {
      return null;
    }
  }
}
