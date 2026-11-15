// Ending a terminal ends every process still in its session (docs/terminal-plan.md §2, "Ending a terminal"; T1
// review items 1 and 2). Driven by a fake PTY and a fake process table, on both platforms' semantics: no real process
// is started or signalled.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeProcessTable, type FakeProcessTable } from './fake-processes';
import { createFakePty, type FakePty } from './fake-pty';
import { SessionProcesses } from './processes';
import { TerminalScreen } from './screen';
import { TerminalSession } from './session';

const SHELL_PID = 4_242;
const GRACE = 1_000;

interface Harness {
  readonly pty: FakePty;
  readonly procs: FakeProcessTable;
  readonly session: TerminalSession;
}

/**
 * A shell in its own session. `shellDiesOn`: the signal the shell exits on (a login shell exits on SIGHUP); 'never'
 * for one that reports no exit at all.
 */
function makeSession(
  platform: 'linux' | 'darwin',
  options: { shellDiesOn?: 'SIGHUP' | 'SIGKILL' | 'never' } = {},
): Harness {
  const procs = createFakeProcessTable(platform);
  const pty = createFakePty(SHELL_PID);
  procs.add({ pid: SHELL_PID, start: 'Sun Nov 15 10:00:00 2026', session: procs.keyOf(SHELL_PID) });
  const dieOn = options.shellDiesOn ?? 'SIGHUP';
  const kill = pty.kill.bind(pty);
  pty.kill = (signal) => {
    kill(signal);
    if (dieOn === 'never') return;
    if (signal === dieOn || signal === 'SIGKILL') {
      procs.leaderExited(SHELL_PID);
      pty.emitExit(0, signal === 'SIGKILL' ? 9 : 1);
    }
  };
  const session = new TerminalSession({
    chatId: 'chat-1',
    pty,
    screen: new TerminalScreen(80, 24),
    shell: 'zsh',
    cwd: '/home/me',
    events: { data: () => {}, exit: () => {} },
    killGraceMs: GRACE,
    processes: new SessionProcesses(SHELL_PID, procs.table),
    signal: procs.signal,
  });
  return { pty, procs, session };
}

/** The reviewer's set: a foreground job, a background job, one that ignores SIGHUP, and a daemon in its own session. */
function addJobs(procs: FakeProcessTable): void {
  const key = procs.keyOf(SHELL_PID);
  procs.add({ pid: 500, start: 'Sun Nov 15 10:00:05 2026', session: key }); // foreground: sleep 600
  procs.add({ pid: 501, start: 'Sun Nov 15 10:00:06 2026', session: key }); // background: sleep 600 &
  procs.add({ pid: 502, start: 'Sun Nov 15 10:00:07 2026', session: key, ignoresHup: true }); // trap '' HUP; sleep &
  procs.add({ pid: 503, start: 'Sun Nov 15 10:00:08 2026', session: null }); // setsid sleep 600 (macOS: no terminal)
  procs.add({ pid: 600, start: 'Sun Nov 15 09:00:00 2026', session: 'tty:16/77' }); // another terminal's process
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(['linux', 'darwin'] as const)('ending a terminal on %s', (platform) => {
  it('SIGHUPs every process in the session, then SIGKILLs the one that ignored it, after the shell is gone', async () => {
    const { pty, procs, session } = makeSession(platform);
    addJobs(procs);
    if (platform === 'linux') procs.add({ pid: 503, start: 'Sun Nov 15 10:00:08 2026', session: 'sid:503' });

    let settled = false;
    const killed = session.kill().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pty.killSignals).toStrictEqual(['SIGHUP']);
    expect(procs.signals).toStrictEqual([
      { pid: 500, signal: 'SIGHUP' },
      { pid: 501, signal: 'SIGHUP' },
      { pid: 502, signal: 'SIGHUP' },
    ]);
    // The shell has gone, but a process in its session is left: the kill waits out the grace period.
    expect(session.running).toBe(false);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(GRACE);
    await killed;
    expect(procs.signals.slice(3)).toStrictEqual([{ pid: 502, signal: 'SIGKILL' }]);
    // Nothing reached the reaped shell, the daemon, or the other terminal's process.
    expect(pty.killSignals).toStrictEqual(['SIGHUP']);
    expect([...procs.processes.keys()].sort()).toStrictEqual([503, 600]);
  });

  it('does not SIGKILL a pid that now belongs to another process (same pid, other start time)', async () => {
    const { procs, session } = makeSession(platform);
    const key = procs.keyOf(SHELL_PID);
    procs.add({ pid: 502, start: 'Sun Nov 15 10:00:07 2026', session: key, ignoresHup: true });

    const killed = session.kill();
    await vi.advanceTimersByTimeAsync(0);
    expect(procs.signals).toStrictEqual([{ pid: 502, signal: 'SIGHUP' }]);
    // During the grace period the job exits and its pid is reused by an unrelated process.
    procs.processes.delete(502);
    procs.add({ pid: 502, start: 'Sun Nov 15 10:00:09 2026', session: null });
    await vi.advanceTimersByTimeAsync(GRACE);
    await killed;
    expect(procs.signals).toStrictEqual([{ pid: 502, signal: 'SIGHUP' }]);
    expect(procs.processes.has(502)).toBe(true);
  });

  it('SIGKILLs the shell too when it ignores SIGHUP, and nothing after it reports its exit', async () => {
    const { pty, procs, session } = makeSession(platform, { shellDiesOn: 'SIGKILL' });
    const killed = session.kill();
    await vi.advanceTimersByTimeAsync(0);
    expect(pty.killSignals).toStrictEqual(['SIGHUP']);
    await vi.advanceTimersByTimeAsync(GRACE);
    await killed;
    expect(pty.killSignals).toStrictEqual(['SIGHUP', 'SIGKILL']);
    expect(session.running).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * GRACE);
    expect(pty.killSignals).toStrictEqual(['SIGHUP', 'SIGKILL']);
    expect(procs.signals).toStrictEqual([]);
  });

  it('gives up waiting for a shell that never reports its exit, and keeps counting it as running', async () => {
    const { pty, session } = makeSession(platform, { shellDiesOn: 'never' });
    let gone = false;
    void session.whenGone().then(() => {
      gone = true;
    });
    const killed = session.kill();
    await vi.advanceTimersByTimeAsync(2 * GRACE);
    await killed;
    expect(pty.killSignals).toStrictEqual(['SIGHUP', 'SIGKILL']);
    expect(session.running).toBe(true);
    expect(gone).toBe(false);
    // When it finally goes, it is gone.
    pty.emitExit(0, 9);
    await vi.advanceTimersByTimeAsync(0);
    expect(gone).toBe(true);
  });

  it('signals only the shell when the process table cannot be read', async () => {
    const { pty, procs, session } = makeSession(platform);
    addJobs(procs);
    procs.failing = true;
    const killed = session.kill();
    await vi.advanceTimersByTimeAsync(0);
    await killed;
    expect(pty.killSignals).toStrictEqual(['SIGHUP']);
    expect(procs.signals).toStrictEqual([]);
  });

  it('killNow SIGKILLs the shell and its session synchronously', () => {
    const { pty, procs, session } = makeSession(platform);
    addJobs(procs);
    session.killNow();
    expect(pty.killSignals).toStrictEqual(['SIGKILL']);
    expect(procs.signals).toStrictEqual([
      { pid: 500, signal: 'SIGKILL' },
      { pid: 501, signal: 'SIGKILL' },
      { pid: 502, signal: 'SIGKILL' },
    ]);
  });

  it('a kill after the shell exited sends nothing to the shell pid, even once it is reused', async () => {
    const { pty, procs, session } = makeSession(platform);
    procs.leaderExited(SHELL_PID);
    pty.emitExit(0);
    // The pid comes back as an unrelated process in a session of its own.
    procs.add({ pid: SHELL_PID, start: 'Sun Nov 15 11:00:00 2026', session: procs.keyOf(SHELL_PID) });
    const killed = session.kill();
    await vi.advanceTimersByTimeAsync(3 * GRACE);
    await killed;
    expect(pty.killSignals).toStrictEqual([]);
    expect(procs.signals).toStrictEqual([]);
  });
});

describe('a shell that exited on its own', () => {
  it('on Linux, End still finds what it left in its session', async () => {
    const { pty, procs, session } = makeSession('linux');
    procs.add({ pid: 700, start: '1000', session: procs.keyOf(SHELL_PID), ignoresHup: true }); // nohup sleep &
    // The user types `exit`.
    procs.leaderExited(SHELL_PID);
    pty.emitExit(0);
    await vi.advanceTimersByTimeAsync(0);
    // The job starts a child of its own later; it is in the same session.
    procs.add({ pid: 701, start: '2000', session: procs.keyOf(SHELL_PID) });

    const killed = session.kill();
    await vi.advanceTimersByTimeAsync(0);
    expect(procs.signals).toStrictEqual([
      { pid: 700, signal: 'SIGHUP' },
      { pid: 701, signal: 'SIGHUP' },
    ]);
    await vi.advanceTimersByTimeAsync(GRACE);
    await killed;
    expect(procs.signals.slice(2)).toStrictEqual([{ pid: 700, signal: 'SIGKILL' }]);
    expect(pty.killSignals).toStrictEqual([]);
  });

  it('on Linux, a session id reused after everything in it has gone is not trusted', async () => {
    const { pty, procs, session } = makeSession('linux');
    procs.leaderExited(SHELL_PID);
    pty.emitExit(0);
    await vi.advanceTimersByTimeAsync(0);
    // Much later the pid is reused as the leader of a new, unrelated session.
    procs.add({ pid: SHELL_PID, start: '9000', session: procs.keyOf(SHELL_PID) });
    procs.add({ pid: 800, start: '9001', session: procs.keyOf(SHELL_PID) });
    const killed = session.kill();
    await vi.advanceTimersByTimeAsync(3 * GRACE);
    await killed;
    expect(procs.signals).toStrictEqual([]);
  });

  it('on macOS, what it left behind can no longer be told apart (a documented limit)', async () => {
    const { pty, procs, session } = makeSession('darwin');
    procs.add({ pid: 700, start: 'Sun Nov 15 10:00:05 2026', session: procs.keyOf(SHELL_PID), ignoresHup: true });
    procs.leaderExited(SHELL_PID); // macOS takes the terminal away: 700 now looks like a daemon
    pty.emitExit(0);
    const killed = session.kill();
    await vi.advanceTimersByTimeAsync(3 * GRACE);
    await killed;
    expect(procs.signals).toStrictEqual([]);
  });
});
