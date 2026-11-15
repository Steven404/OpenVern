// Which processes belong to a terminal's session, and how they are signalled (docs/terminal-plan.md §2, "Ending a
// terminal"). The shell is the leader of a new session (node-pty calls setsid). Ending a terminal signals every
// process still in that session, not only the shell, so a background job that ignores SIGHUP does not outlive it; a
// process that moved itself into its own session (a daemon) is left alone.
//
// A process is named by its pid plus its start time, never by pid alone, and the process table is read again right
// before every signal, so a pid that was reaped and reused by an unrelated process is not signalled. Reading the
// table and sending the signal are injected (`ProcessTable`, `SignalProcess`), so this is unit-tested without
// processes.
//
// How membership is known differs by platform:
// - Linux: `/proc/<pid>/stat` gives each process's session id, which stays the shell's pid after the shell exits.
//   That pid cannot be reused while any process is still in the session (POSIX), so the session id is trusted while
//   the shell is alive, right after it exits, and later while a process seen earlier in the session is still there.
// - macOS: `ps` prints 0 for the session id, so the controlling terminal stands in for it: every process in the
//   session shares it, and one that called setsid has none. When the shell exits, the kernel takes the terminal away
//   from the processes left in the session, so after that only those seen while the shell was alive (by pid and
//   start time) can still be found.

import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ProcessEntry {
  pid: number;
  /** When the process started, as the platform reports it. With `pid`, names one process for its lifetime. */
  start: string;
  /** The session it belongs to as far as the platform tells (Linux: session id; macOS: controlling terminal). */
  session: string | null;
}

export interface ProcessTable {
  /** Whether a process keeps its `session` after the session leader exits (Linux: yes; macOS: no). */
  readonly keyOutlivesLeader: boolean;
  /** The `session` of a session led by `pid`, when it can be told without looking (Linux), else null. */
  leaderKey(pid: number): string | null;
  list(): Promise<ProcessEntry[]>;
  /** For process exit, when nothing can wait. */
  listSync(): ProcessEntry[];
}

export type KillSignal = 'SIGHUP' | 'SIGKILL';
export type SignalProcess = (pid: number, signal: KillSignal) => void;

/** `process.kill`, quiet when the process has gone or is not ours. */
export const signalProcess: SignalProcess = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH or EPERM: nothing to do.
  }
};

// macOS: one `ps` call. `tdev` is the controlling terminal's device number, `??` for none; `lstart` is the start time
// to the second, last because it contains spaces.
const PS_FILE = '/bin/ps';
const PS_ARGS = ['-A', '-o', 'pid=,tdev=,lstart='];
const PS_ENV = { LC_ALL: 'C', PATH: '/usr/bin:/bin' };
const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BUFFER = 16 * 1024 * 1024;

export function parsePsOutput(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, tdev, start] = match as unknown as [string, string, string, string];
    entries.push({ pid: Number(pid), start, session: tdev === '??' || tdev === '-' ? null : `tty:${tdev}` });
  }
  return entries;
}

export function createPsProcessTable(): ProcessTable {
  return {
    keyOutlivesLeader: false,
    leaderKey: () => null,
    list: () =>
      new Promise((resolve, reject) => {
        execFile(
          PS_FILE,
          PS_ARGS,
          { env: PS_ENV, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, encoding: 'utf8' },
          (err, stdout) => (err ? reject(err) : resolve(parsePsOutput(stdout))),
        );
      }),
    listSync: () =>
      parsePsOutput(
        execFileSync(PS_FILE, PS_ARGS, {
          env: PS_ENV,
          timeout: PS_TIMEOUT_MS,
          maxBuffer: PS_MAX_BUFFER,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ),
  };
}

/**
 * One `/proc/<pid>/stat` line. The command name is in parentheses and may itself hold spaces and parentheses, so the
 * fields are counted from the last `)`: after it come state (field 3), ppid, pgrp, session (6), …, starttime (22).
 */
export function parseProcStat(pid: number, text: string): ProcessEntry | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const session = fields[3];
  const start = fields[19];
  if (!session || !start || !/^\d+$/.test(session) || !/^\d+$/.test(start)) return null;
  return { pid, start, session: `sid:${session}` };
}

const isPidName = (name: string) => /^\d+$/.test(name);

export function createProcProcessTable(root = '/proc'): ProcessTable {
  return {
    keyOutlivesLeader: true,
    // A session leader's session id is its own pid.
    leaderKey: (pid) => `sid:${pid}`,
    list: async () => {
      const names = (await readdir(root)).filter(isPidName);
      const entries = await Promise.all(
        names.map(async (name) => {
          try {
            return parseProcStat(Number(name), await readFile(join(root, name, 'stat'), 'utf8'));
          } catch {
            return null; // Exited while we looked.
          }
        }),
      );
      return entries.filter((entry): entry is ProcessEntry => entry !== null);
    },
    listSync: () => {
      const entries: ProcessEntry[] = [];
      for (const name of readdirSync(root).filter(isPidName)) {
        try {
          const entry = parseProcStat(Number(name), readFileSync(join(root, name, 'stat'), 'utf8'));
          if (entry) entries.push(entry);
        } catch {
          // Exited while we looked.
        }
      }
      return entries;
    },
  };
}

/** The table for this platform, or null where there is none (the shell alone is then signalled). */
export function createProcessTable(platform: NodeJS.Platform = process.platform): ProcessTable | null {
  if (platform === 'darwin') return createPsProcessTable();
  if (platform === 'linux') return createProcProcessTable();
  return null;
}

/**
 * The processes of one terminal's session, apart from the shell itself (the session signals the shell through its
 * PTY, and only while node-pty has not reported its exit, so a reaped shell pid is never signalled).
 */
export class SessionProcesses {
  private leaderStart: string | null = null;
  private key: string | null;
  private leaderExited = false;
  /** pid → start time of the processes found in the session last time. */
  private tracked = new Map<number, string>();

  constructor(
    private readonly leaderPid: number,
    private readonly table: ProcessTable | null,
  ) {
    this.key = table?.leaderKey(leaderPid) ?? null;
  }

  /** node-pty reported the shell's exit: its pid is reaped and may belong to another process from now on. */
  leaderGone(): void {
    this.leaderExited = true;
  }

  /** How many processes the last lookup found (for tests and logs). */
  get trackedCount(): number {
    return this.tracked.size;
  }

  /** The process table now, or null when there is none or it cannot be read. */
  async snapshot(): Promise<ProcessEntry[] | null> {
    if (!this.table) return null;
    try {
      return await this.table.list();
    } catch {
      return null;
    }
  }

  snapshotSync(): ProcessEntry[] | null {
    if (!this.table) return null;
    try {
      return this.table.listSync();
    } catch {
      return null;
    }
  }

  /**
   * The session's processes other than the shell, in `snapshot`, remembered for the next lookup. `justExited`: the
   * shell exited a moment ago, so on Linux its session id is trusted once even with nothing remembered yet.
   */
  members(snapshot: readonly ProcessEntry[] | null, options: { justExited?: boolean } = {}): ProcessEntry[] {
    if (!snapshot || !this.table) return [];
    const leader = this.leaderExited
      ? undefined
      : snapshot.find(
          (entry) => entry.pid === this.leaderPid && (this.leaderStart === null || entry.start === this.leaderStart),
        );
    if (leader) {
      this.leaderStart ??= leader.start;
      if (leader.session !== null) this.key = leader.session;
    }
    const key = this.key;
    const isTracked = (entry: ProcessEntry) => this.tracked.get(entry.pid) === entry.start;
    const keyHolds =
      key !== null &&
      (leader !== undefined ||
        (this.table.keyOutlivesLeader &&
          (options.justExited === true || snapshot.some((entry) => isTracked(entry) && entry.session === key))));
    const revokesOnExit = !this.table.keyOutlivesLeader && leader === undefined;
    const found = snapshot.filter((entry) => {
      if (entry.pid === this.leaderPid) return false;
      if (keyHolds && entry.session === key) return true;
      if (!isTracked(entry)) return false;
      // Seen in the session before: still in it, unless it has moved to a session of its own. On macOS a process
      // left behind by the shell has lost its terminal, which is not a move.
      return (key !== null && entry.session === key) || (revokesOnExit && entry.session === null);
    });
    this.tracked = new Map(found.map((entry) => [entry.pid, entry.start]));
    return found;
  }
}
