// Terminal sessions by chat id (plan T1.3, T1.4). Inputs here are already validated (./validate.ts); the PTY, the
// shell, the file system and where events go are injected, so tests can run it with a fake PTY.

import { basename, isAbsolute, resolve } from 'node:path';
import { TERMINAL, type TerminalOpenResult, type TerminalReadAnswer, type TerminalReadRequest } from '@shared/terminal';
import type { Id } from '@shared/types';
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
  killGraceMs?: number;
  maxSessions?: number;
  scrollbackLines?: number;
}

export interface OpenParams {
  chatId: Id;
  /** null = the home folder. */
  cwd: string | null;
  cols: number;
  rows: number;
}

export class TerminalLimitError extends Error {
  constructor(max: number) {
    super(`At most ${max} terminals can run at once. End one to open another.`);
    this.name = 'TerminalLimitError';
  }
}

export class TerminalManager {
  private readonly sessions = new Map<Id, TerminalSession>();
  /** Forgotten sessions whose shells may still be shutting down. */
  private readonly dying = new Set<TerminalSession>();
  private readonly maxSessions: number;

  constructor(private readonly deps: TerminalManagerDeps) {
    this.maxSessions = deps.maxSessions ?? TERMINAL.maxSessions;
  }

  get size(): number {
    return this.sessions.size;
  }

  has(chatId: Id): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Attaches to the chat's running session (its snapshot and `seq`; the requested size is ignored, `info` carries the
   * session's), or starts a new one. An exited session is replaced. Throws `TerminalLimitError` at `maxSessions`, and
   * whatever the spawn throws.
   */
  async open(params: OpenParams): Promise<TerminalOpenResult> {
    const existing = this.sessions.get(params.chatId);
    if (existing?.running) {
      const { snapshot, seq, info } = await existing.snapshot();
      return { info, snapshot, seq, created: false };
    }
    if (existing) this.forget(existing);
    // Synchronous from here to the map insert, so two opens for one chat can't both create.
    this.makeRoom();
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

  /** Kills the shell and forgets the session. Resolves at once; the shell finishes dying in the background. */
  async close(chatId: Id): Promise<void> {
    const session = this.sessions.get(chatId);
    if (session) this.forget(session);
  }

  /** Forgets every session and resolves once all their shells have exited (SIGKILL after the grace period). */
  async disposeAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) this.forget(session);
    await Promise.all([...this.dying].map((session) => session.kill()));
  }

  /** SIGKILL to every shell that may still be running. Synchronous, for `process.on('exit')`. */
  killAllNow(): void {
    for (const session of this.sessions.values()) session.killNow();
    for (const session of this.dying) session.killNow();
  }

  private forget(session: TerminalSession): void {
    if (this.sessions.get(session.chatId) === session) this.sessions.delete(session.chatId);
    if (!session.running) {
      void session.dispose();
      return;
    }
    this.dying.add(session);
    void session.dispose().finally(() => this.dying.delete(session));
  }

  /** At the limit, drops the oldest exited session (kept only for reads); refuses when all of them are running. */
  private makeRoom(): void {
    if (this.sessions.size < this.maxSessions) return;
    for (const session of this.sessions.values()) {
      if (!session.running) {
        this.forget(session);
        return;
      }
    }
    throw new TerminalLimitError(this.maxSessions);
  }

  private create(params: OpenParams): TerminalSession {
    const cwd = this.resolveCwd(params.cwd);
    const shell = this.deps.shell();
    const screen = new TerminalScreen(params.cols, params.rows, this.deps.scrollbackLines ?? TERMINAL.scrollbackLines);
    let pty: PtyProcess;
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
