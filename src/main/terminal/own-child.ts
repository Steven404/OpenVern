// Whether a pid still names a child of this process (docs/terminal-plan.md T1.4). The session asks right before it
// signals its shell: node-pty reaps the shell in a native thread and reports the exit up to 200 ms later, and in
// that window the pid could in principle be reused by an unrelated process, whose parent would not be us. A shell
// that has exited but is not yet reaped is a zombie that still has us as its parent; signalling it does nothing.
//
// Synchronous on purpose: the signal follows the check with no turn of the event loop in between. Any failure
// (no such process, an unreadable /proc, no `ps`) answers false, so the signal is skipped rather than sent blind.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** True only when `pid` is currently a child of this process. Must not throw. */
export type IsOwnChild = (pid: number) => boolean;

function isPid(pid: number): boolean {
  // 0 and negative values name process groups for kill(2), never a single process.
  return Number.isSafeInteger(pid) && pid > 0;
}

/**
 * The parent pid in one `/proc/<pid>/stat` line. The command name is in parentheses and may itself hold spaces and
 * parentheses, so the fields are counted from the last `)`: state, then the parent pid.
 */
export function parseProcStatParent(text: string): number | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const ppid = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)[1];
  return ppid !== undefined && /^\d+$/.test(ppid) ? Number(ppid) : null;
}

/** The output of `ps -o ppid= -p <pid>`: one number, padded with spaces. */
export function parsePsParent(text: string): number | null {
  const value = text.trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

export function procParentOf(pid: number, root = '/proc'): number | null {
  try {
    return parseProcStatParent(readFileSync(`${root}/${pid}/stat`, 'utf8'));
  } catch {
    return null; // Gone, or /proc is not readable.
  }
}

const PS_FILE = '/bin/ps';
const PS_ENV = { LC_ALL: 'C', PATH: '/usr/bin:/bin' };
const PS_TIMEOUT_MS = 2_000;

export function psParentOf(pid: number): number | null {
  try {
    const out = execFileSync(PS_FILE, ['-o', 'ppid=', '-p', String(pid)], {
      env: PS_ENV,
      timeout: PS_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePsParent(out);
  } catch {
    return null; // `ps` exits 1 when there is no such process.
  }
}

/**
 * The check for this platform: /proc on Linux, `ps` on macOS. Elsewhere it always answers false, so the shell is
 * never signalled by pid (closing its terminal device still hangs it up).
 */
export function createIsOwnChild(
  platform: NodeJS.Platform = process.platform,
  parentOf: (pid: number) => number | null = platform === 'linux'
    ? procParentOf
    : platform === 'darwin'
      ? psParentOf
      : () => null,
  ownPid: number = process.pid,
): IsOwnChild {
  return (pid) => {
    if (!isPid(pid)) return false;
    try {
      return parentOf(pid) === ownPid;
    } catch {
      return false;
    }
  };
}
