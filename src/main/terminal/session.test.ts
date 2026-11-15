// One session: sequence numbers, exit handling and the kill escalation (docs/terminal-plan.md T1.2, T1.6).

import { TERMINAL, type TerminalDataEvent, type TerminalExitEvent } from '@shared/terminal';
import { describe, expect, it, vi } from 'vitest';
import { createFakePty, type FakePty } from './fake-pty';
import { TerminalScreen } from './screen';
import { KILL_GRACE_MS, TerminalSession } from './session';

interface Harness {
  readonly pty: FakePty;
  readonly session: TerminalSession;
  readonly data: TerminalDataEvent[];
  readonly exits: TerminalExitEvent[];
}

interface SessionOverrides {
  killGraceMs?: number;
  pty?: FakePty;
  pendingInputMaxBytes?: number;
  log?: (message: string) => void;
}

function makeSession(options: SessionOverrides = {}): Harness {
  const pty = options.pty ?? createFakePty();
  const data: TerminalDataEvent[] = [];
  const exits: TerminalExitEvent[] = [];
  const session = new TerminalSession({
    chatId: 'terminal-1',
    pty,
    screen: new TerminalScreen(80, 24),
    shell: 'zsh',
    cwd: '/home/me',
    events: { data: (event) => data.push(event), exit: (event) => exits.push(event) },
    killGraceMs: options.killGraceMs,
    pendingInputMaxBytes: options.pendingInputMaxBytes,
    log: options.log ?? (() => {}),
  });
  return { pty, session, data, exits };
}

describe('TerminalSession data events', () => {
  it('increases seq by exactly one per data event', () => {
    const { pty, session, data } = makeSession();
    pty.emitData('a');
    pty.emitData('bc');
    pty.emitData('def');
    expect(data).toStrictEqual([
      { chatId: 'terminal-1', seq: 1, data: 'a' },
      { chatId: 'terminal-1', seq: 2, data: 'bc' },
      { chatId: 'terminal-1', seq: 3, data: 'def' },
    ]);
    expect(session.lastSeq).toBe(3);
  });

  it('returns a snapshot whose seq matches the events it contains', async () => {
    const { pty, session, data } = makeSession();
    pty.emitData('first\r\n');
    pty.emitData('second\r\n');
    const snapshot = await session.snapshot();
    expect(snapshot.seq).toBe(2);
    expect(snapshot.snapshot).toContain('first');
    expect(snapshot.snapshot).toContain('second');
    expect(snapshot.info).toStrictEqual({
      chatId: 'terminal-1',
      shell: 'zsh',
      cwd: '/home/me',
      cols: 80,
      rows: 24,
      status: { state: 'running' },
    });

    // Later output is a later event: a renderer replays the snapshot, then applies events with a greater seq.
    pty.emitData('third\r\n');
    expect(data.at(-1)?.seq).toBe(3);
    const later = await session.snapshot();
    expect(later.seq).toBe(3);
    expect(later.snapshot).toContain('third');
  });

  it('does not write to the PTY once the shell has exited', () => {
    const { pty, session } = makeSession();
    pty.emitExit(0);
    session.write('typed after exit');
    expect(pty.writes).toStrictEqual([]);
  });

  it('stops forwarding data and exit events once muted', () => {
    const { pty, session, data, exits } = makeSession();
    session.mute();
    pty.emitData('hidden');
    pty.emitExit(0);
    expect(data).toStrictEqual([]);
    expect(exits).toStrictEqual([]);
  });
});

describe('TerminalSession output boundaries', () => {
  it('ends an event before an incomplete escape sequence and sends it with the rest', () => {
    const { pty, data } = makeSession();
    pty.emitData('x \u001b[31');
    pty.emitData('mR');
    expect(data).toStrictEqual([
      { chatId: 'terminal-1', seq: 1, data: 'x ' },
      { chatId: 'terminal-1', seq: 2, data: '\u001b[31mR' },
    ]);
  });

  it('sends no event, and uses no seq, for a chunk that is all incomplete sequence', async () => {
    const { pty, session, data } = makeSession();
    pty.emitData('\u001b]0;tit');
    expect(data).toStrictEqual([]);
    expect(session.lastSeq).toBe(0);
    // The snapshot is at rest: it holds nothing of the open sequence.
    const snapshot = await session.snapshot();
    expect(snapshot.seq).toBe(0);
    expect(snapshot.snapshot).not.toContain('tit');
  });

  it('flushes what is held when the shell exits, before the exit event', () => {
    const { pty, data, exits } = makeSession();
    pty.emitData('done\u001b[');
    pty.emitExit(0);
    expect(data.map((event) => event.data)).toStrictEqual(['done', '\u001b[']);
    expect(exits).toHaveLength(1);
  });
});

describe('TerminalSession queued input', () => {
  it('defaults to the plan’s 1 MiB bound', () => {
    expect(TERMINAL.pendingInputMaxBytes).toBe(1024 * 1024);
  });

  it('drops writes that would queue more than the bound, with one warning per stretch of drops', () => {
    const logs: string[] = [];
    const { pty, session } = makeSession({ pendingInputMaxBytes: 10, log: (line) => logs.push(line) });
    session.write('12345');
    session.write('67890');
    // The shell is not reading: 10 bytes wait.
    for (let i = 0; i < 128; i++) session.write('more');
    expect(pty.writes).toStrictEqual(['12345', '67890']);
    expect(pty.pendingBytes).toBe(10);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/not reading its input/);

    // It reads again: input flows, and a later stretch of drops warns once more.
    pty.drainInput();
    session.write('ok');
    expect(pty.writes.at(-1)).toBe('ok');
    session.write('x'.repeat(9));
    session.write('y'.repeat(9));
    expect(logs).toHaveLength(2);
  });

  it('measures in UTF-8 bytes', () => {
    const { pty, session } = makeSession({ pendingInputMaxBytes: 6 });
    session.write('éé'); // 4 bytes
    session.write('éé'); // would be 8
    expect(pty.writes).toStrictEqual(['éé']);
  });

  it('the reviewer’s case: 128 writes of 64 KiB to a shell that does not read queue at most 1 MiB', () => {
    const { pty, session } = makeSession();
    const chunk = 'x'.repeat(TERMINAL.writeMaxBytes);
    for (let i = 0; i < 128; i++) session.write(chunk);
    expect(pty.pendingBytes).toBeLessThanOrEqual(TERMINAL.pendingInputMaxBytes);
    expect(pty.writes).toHaveLength(16);
  });

  it('warns once and passes input through when node-pty’s queue cannot be measured', () => {
    const logs: string[] = [];
    const pty = createFakePty(4_242, { pendingInput: 'unknown' });
    const { session } = makeSession({ pty, pendingInputMaxBytes: 1, log: (line) => logs.push(line) });
    session.write('abc');
    session.write('def');
    expect(pty.writes).toStrictEqual(['abc', 'def']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/cannot measure/);
  });
});

describe('TerminalSession input and size', () => {
  it('passes writes and resizes to the PTY while running', () => {
    const { pty, session } = makeSession();
    session.write('ls\r');
    session.resize(100, 30);
    expect(pty.writes).toStrictEqual(['ls\r']);
    expect(pty.resizes).toStrictEqual([{ cols: 100, rows: 30 }]);
    expect(session.info()).toMatchObject({ cols: 100, rows: 30 });
    // The same size twice is a no-op.
    session.resize(100, 30);
    expect(pty.resizes).toHaveLength(1);
  });

  it('resizes the screen but not a dead PTY after exit', () => {
    const { pty, session } = makeSession();
    pty.emitExit(0);
    session.resize(120, 40);
    expect(pty.resizes).toStrictEqual([]);
    expect(session.info()).toMatchObject({ cols: 120, rows: 40 });
  });
});

describe('TerminalSession exit', () => {
  it('records the code and emits exit, and never signals the reaped shell', () => {
    const { pty, session, exits } = makeSession();
    pty.emitExit(3);
    expect(exits).toStrictEqual([{ chatId: 'terminal-1', status: { state: 'exited', exitCode: 3, signal: null } }]);
    expect(session.running).toBe(false);
    expect(session.info().status).toStrictEqual({ state: 'exited', exitCode: 3, signal: null });
    // node-pty has reaped the shell; its pid may already belong to another process (T1 review).
    expect(pty.killSignals).toStrictEqual([]);
  });

  it('records a signal death without a code', () => {
    const { pty, exits } = makeSession();
    pty.emitExit(0, 9);
    expect(exits).toStrictEqual([{ chatId: 'terminal-1', status: { state: 'exited', exitCode: null, signal: 9 } }]);
  });

  it('emits exit once, however many times the PTY reports it', () => {
    const { pty, exits } = makeSession();
    pty.emitExit(0);
    pty.emitExit(1, 9);
    expect(exits).toStrictEqual([{ chatId: 'terminal-1', status: { state: 'exited', exitCode: 0, signal: null } }]);
    expect(pty.killSignals).toStrictEqual([]);
  });
});

describe('TerminalSession kill', () => {
  it('sends SIGHUP, escalates to SIGKILL after the grace period, then settles', async () => {
    vi.useFakeTimers();
    try {
      const { pty, session } = makeSession({ killGraceMs: 500 });
      let settled = false;
      const killed = session.kill().then(() => {
        settled = true;
      });
      // The session's processes are looked up first (none here), then signalled.
      await vi.advanceTimersByTimeAsync(0);
      expect(pty.killSignals).toStrictEqual(['SIGHUP']);

      await vi.advanceTimersByTimeAsync(499);
      expect(pty.killSignals).toStrictEqual(['SIGHUP']);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(pty.killSignals).toStrictEqual(['SIGHUP', 'SIGKILL']);
      expect(settled).toBe(false);

      // The second grace period is the last resort for a shell that never reports its exit.
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(true);
      await killed;
      // One kill chain per session.
      expect(session.kill()).toBe(session.kill());
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults to the one-second grace period from the plan', async () => {
    expect(KILL_GRACE_MS).toBe(1_000);
    vi.useFakeTimers();
    try {
      const { pty, session } = makeSession();
      const killed = session.kill();
      await vi.advanceTimersByTimeAsync(999);
      expect(pty.killSignals).toStrictEqual(['SIGHUP']);
      await vi.advanceTimersByTimeAsync(1);
      expect(pty.killSignals).toStrictEqual(['SIGHUP', 'SIGKILL']);
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      await killed;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves as soon as the shell exits, and sends no SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const { pty, session } = makeSession({ killGraceMs: 1_000 });
      let settled = false;
      const killed = session.kill().then(() => {
        settled = true;
      });
      pty.emitExit(0, 15);
      await killed;
      expect(settled).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pty.killSignals).not.toContain('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves at once for a session that already exited', async () => {
    const { pty, session } = makeSession();
    pty.emitExit(0);
    pty.killSignals.length = 0;
    await expect(session.kill()).resolves.toBeUndefined();
    expect(pty.killSignals).toStrictEqual([]);
  });

  it('killNow sends SIGKILL immediately', () => {
    const { pty, session } = makeSession();
    session.killNow();
    expect(pty.killSignals).toStrictEqual(['SIGKILL']);
  });

  it('dispose detaches the PTY and rejects a pending read', async () => {
    const { pty, session, data } = makeSession({ killGraceMs: 1 });
    const pending = session.read({});
    const disposed = session.dispose();
    // A real shell reports the exit; the fake one needs telling.
    pty.emitExit(0, 15);
    await expect(pending).rejects.toThrow('The terminal was closed.');
    await disposed;
    expect(pty.dataListenerCount).toBe(0);
    expect(pty.exitListenerCount).toBe(0);
    pty.emitData('late');
    expect(data).toStrictEqual([]);
  });
});
