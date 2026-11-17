// One session (docs/terminal-plan.md T1.2, T1.4): raw output with `seq`, the replay that agrees with it, the input
// bound that fails closed, exit handling, and ending the shell. Driven by a fake PTY; the own-child check is injected.

import { TERMINAL, type TerminalDataEvent, type TerminalExitEvent } from '@shared/terminal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePty, type FakePty, type PendingInputMode } from './fake-pty';
import { INPUT_DROPPED_NOTICE, INPUT_UNMEASURABLE_NOTICE, KILL_GRACE_MS, TerminalSession } from './session';

interface Harness {
  readonly pty: FakePty;
  readonly session: TerminalSession;
  readonly data: TerminalDataEvent[];
  readonly exits: TerminalExitEvent[];
  readonly log: ReturnType<typeof vi.fn>;
  /** pids the own-child check was asked about, in order. */
  readonly checked: number[];
  /** What the own-child check answers from now on. */
  ownChild: boolean;
}

interface SessionOverrides {
  killGraceMs?: number;
  pendingInputMaxBytes?: number;
  replayMaxBytes?: number;
  pendingInput?: PendingInputMode;
}

function makeSession(options: SessionOverrides = {}): Harness {
  const pty = createFakePty(4_242, { pendingInput: options.pendingInput });
  const data: TerminalDataEvent[] = [];
  const exits: TerminalExitEvent[] = [];
  const log = vi.fn();
  const checked: number[] = [];
  const harness = {
    pty,
    data,
    exits,
    log,
    checked,
    ownChild: true,
  } as Omit<Harness, 'session'> & { session?: TerminalSession; ownChild: boolean };
  harness.session = new TerminalSession({
    chatId: 'chat-1',
    pty,
    shell: 'zsh',
    cwd: '/home/me',
    cols: 80,
    rows: 24,
    events: { data: (event) => data.push(event), exit: (event) => exits.push(event) },
    isOwnChild: (pid) => {
      checked.push(pid);
      return harness.ownChild;
    },
    killGraceMs: options.killGraceMs,
    pendingInputMaxBytes: options.pendingInputMaxBytes,
    replayMaxBytes: options.replayMaxBytes,
    log,
  });
  return harness as Harness;
}

describe('TerminalSession.rekey', () => {
  it('changes the chat id in info() and in every later data and exit event, keeping seq and replay', () => {
    const { pty, session, data, exits } = makeSession();
    pty.emitData('one');
    session.rekey('chat-2');
    expect(session.chatId).toBe('chat-2');
    expect(session.info().chatId).toBe('chat-2');
    pty.emitData('two');
    pty.emitExit(0);
    expect(data).toStrictEqual([
      { chatId: 'chat-1', seq: 1, data: 'one' },
      { chatId: 'chat-2', seq: 2, data: 'two' },
    ]);
    expect(exits).toStrictEqual([{ chatId: 'chat-2', status: { state: 'exited', exitCode: 0, signal: null } }]);
    expect(session.replay()).toStrictEqual({ replay: 'onetwo', replayTruncated: false, seq: 2 });
  });
});

describe('TerminalSession output', () => {
  it('forwards output unmodified, with seq increasing by exactly one per event', () => {
    const { pty, session, data } = makeSession();
    // Half an escape sequence, a lone ESC, and the rest: main never looks inside.
    pty.emitData('a\x1b[3');
    pty.emitData('1mb\x1b');
    pty.emitData(']8;;x\x07');
    expect(data).toStrictEqual([
      { chatId: 'chat-1', seq: 1, data: 'a\x1b[3' },
      { chatId: 'chat-1', seq: 2, data: '1mb\x1b' },
      { chatId: 'chat-1', seq: 3, data: ']8;;x\x07' },
    ]);
    expect(session.lastSeq).toBe(3);
  });

  it('passes a sequence that once made the emulator in main ask for gigabytes straight through', () => {
    const { pty, session, data } = makeSession();
    pty.emitData('\x1b[99999999L');
    expect(data).toStrictEqual([{ chatId: 'chat-1', seq: 1, data: '\x1b[99999999L' }]);
    expect(session.replay()).toStrictEqual({ replay: '\x1b[99999999L', replayTruncated: false, seq: 1 });
  });

  it('sends no event and uses no seq for an empty chunk', () => {
    const { pty, session, data } = makeSession();
    pty.emitData('');
    expect(data).toStrictEqual([]);
    expect(session.lastSeq).toBe(0);
  });

  it('starts with an empty replay at seq 0', () => {
    const { session } = makeSession();
    expect(session.replay()).toStrictEqual({ replay: '', replayTruncated: false, seq: 0 });
  });
});

describe('TerminalSession replay and seq', () => {
  it('holds every event up to its seq and none after, read between any two events', () => {
    const { pty, session, data } = makeSession();
    const chunks = ['$ ', 'l', 's', '\r\n', 'a.txt  b.txt\r\n', '\x1b[1m$ \x1b[0m'];
    for (const chunk of chunks) {
      const { replay, seq } = session.replay();
      // Exactly the events with seq <= the replay's seq, concatenated.
      expect(replay).toBe(
        data
          .filter((event) => event.seq <= seq)
          .map((event) => event.data)
          .join(''),
      );
      expect(data.every((event) => event.seq <= seq)).toBe(true);
      pty.emitData(chunk);
    }
    expect(session.replay()).toStrictEqual({ replay: chunks.join(''), replayTruncated: false, seq: chunks.length });
  });

  it('when truncated, holds a suffix of the events up to seq that starts at a line start', () => {
    const { pty, session, data } = makeSession({ replayMaxBytes: 32 });
    for (let i = 0; i < 20; i++) pty.emitData(`line ${i}\r\n`);
    pty.emitData('$ ');
    const { replay, replayTruncated, seq } = session.replay();
    const all = data
      .filter((event) => event.seq <= seq)
      .map((event) => event.data)
      .join('');
    expect(seq).toBe(21);
    expect(replayTruncated).toBe(true);
    expect(Buffer.byteLength(replay, 'utf8')).toBeLessThanOrEqual(32);
    expect(all.endsWith(replay)).toBe(true);
    expect(all[all.length - replay.length - 1]).toBe('\n');
    expect(replay.endsWith('line 19\r\n$ ')).toBe(true);
  });

  it('clearReplay drops the kept output and keeps the shell, its seq and new output', () => {
    const { pty, session, data } = makeSession();
    pty.emitData('\x1b[crash me\r\n$ ');
    session.clearReplay();
    expect(session.replay()).toStrictEqual({ replay: '', replayTruncated: true, seq: 1 });
    expect(session.running).toBe(true);
    expect(pty.killSignals).toStrictEqual([]);
    expect(pty.closeCount).toBe(0);
    pty.emitData('ls\r\nfile\r\n');
    expect(session.replay()).toStrictEqual({ replay: 'file\r\n', replayTruncated: true, seq: 2 });
    expect(data.map((event) => event.seq)).toStrictEqual([1, 2]);
  });
});

describe('TerminalSession queued input', () => {
  it('defaults to the plan’s 1 MiB bound', () => {
    expect(TERMINAL.pendingInputMaxBytes).toBe(1024 * 1024);
  });

  it('drops writes that would queue more than the bound, with one log line per stretch of drops', () => {
    const { pty, session, log, data } = makeSession({ pendingInputMaxBytes: 10 });
    const notices = () => data.filter((event) => event.data === INPUT_DROPPED_NOTICE).length;
    session.write('12345');
    session.write('67890');
    session.write('x');
    session.write('y');
    expect(pty.writes).toStrictEqual(['12345', '67890']);
    expect(log).toHaveBeenCalledTimes(1);
    // The user is told too, once per stretch, so a paste that was cut short is not a silent loss.
    expect(notices()).toBe(1);
    pty.drainInput();
    session.write('z');
    expect(pty.writes).toStrictEqual(['12345', '67890', 'z']);
    session.write('0123456789');
    expect(log).toHaveBeenCalledTimes(2);
    expect(notices()).toBe(2);
  });

  it('measures in UTF-8 bytes', () => {
    const { pty, session } = makeSession({ pendingInputMaxBytes: 8 });
    session.write('😀');
    session.write('😀');
    session.write('é');
    expect(pty.writes).toStrictEqual(['😀', '😀']);
  });

  it('the reviewer’s case: 128 writes of 64 KiB to a shell that does not read queue at most 1 MiB', () => {
    const { pty, session } = makeSession();
    const chunk = 'a'.repeat(TERMINAL.writeMaxBytes);
    for (let i = 0; i < 128; i++) session.write(chunk);
    expect(pty.pendingBytes).toBeLessThanOrEqual(TERMINAL.pendingInputMaxBytes);
    expect(pty.writes).toHaveLength(16);
  });

  it.each(['unknown', 'nan', 'negative', 'infinite', 'throws'] as const)(
    'refuses input for good when the measurement is %s, and says so in the terminal once',
    (mode) => {
      const { pty, session, data, log } = makeSession({ pendingInput: mode });
      pty.emitData('$ ');
      session.write('ls\r');
      session.write('pwd\r');
      expect(pty.writes).toStrictEqual([]);
      expect(data).toStrictEqual([
        { chatId: 'chat-1', seq: 1, data: '$ ' },
        { chatId: 'chat-1', seq: 2, data: INPUT_UNMEASURABLE_NOTICE },
      ]);
      // The notice is terminal output like any other, so a reload replays it.
      expect(session.replay()).toStrictEqual({
        replay: `$ ${INPUT_UNMEASURABLE_NOTICE}`,
        replayTruncated: false,
        seq: 2,
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot measure'));
      // Even if the measurement comes back, the session stays refused: it does not flip between bounded and not.
      pty.pendingInput = 'tracked';
      session.write('ls\r');
      expect(pty.writes).toStrictEqual([]);
      expect(session.running).toBe(true);
    },
  );

  it('the notice is plain text on lines of its own', () => {
    expect(INPUT_UNMEASURABLE_NOTICE.startsWith('\r\n')).toBe(true);
    expect(INPUT_UNMEASURABLE_NOTICE.endsWith('\r\n')).toBe(true);
    expect(INPUT_UNMEASURABLE_NOTICE).not.toContain('\x1b');
  });
});

describe('TerminalSession input and size', () => {
  it('passes writes and resizes to the PTY while running, and keeps the size in info', () => {
    const { pty, session } = makeSession();
    session.write('ls\r');
    session.write('');
    session.resize(100, 30);
    session.resize(100, 30);
    expect(pty.writes).toStrictEqual(['ls\r']);
    expect(pty.resizes).toStrictEqual([{ cols: 100, rows: 30 }]);
    expect(session.info()).toStrictEqual({
      chatId: 'chat-1',
      shell: 'zsh',
      cwd: '/home/me',
      cols: 100,
      rows: 30,
      status: { state: 'running' },
    });
  });

  it('after exit, writes go nowhere and a resize only updates info', () => {
    const { pty, session } = makeSession();
    pty.emitExit(0);
    session.write('ls\r');
    session.resize(120, 40);
    expect(pty.writes).toStrictEqual([]);
    expect(pty.resizes).toStrictEqual([]);
    expect(session.info()).toMatchObject({ cols: 120, rows: 40 });
  });

  it('a resize that throws (the PTY closed before the exit report) is swallowed', () => {
    const { pty, session } = makeSession();
    pty.resize = () => {
      throw new Error('ioctl(2) failed, EBADF');
    };
    expect(() => session.resize(90, 30)).not.toThrow();
    expect(session.info()).toMatchObject({ cols: 90, rows: 30 });
  });
});

describe('TerminalSession exit', () => {
  it('records the code, emits exit, and detaches from the PTY', () => {
    const { pty, session, exits } = makeSession();
    pty.emitExit(3);
    expect(session.running).toBe(false);
    expect(exits).toStrictEqual([{ chatId: 'chat-1', status: { state: 'exited', exitCode: 3, signal: null } }]);
    expect(session.info().status).toStrictEqual({ state: 'exited', exitCode: 3, signal: null });
    expect(pty.dataListenerCount).toBe(0);
    expect(pty.exitListenerCount).toBe(0);
  });

  it('records a signal death without a code', () => {
    const { pty, session } = makeSession();
    pty.emitExit(0, 9);
    expect(session.info().status).toStrictEqual({ state: 'exited', exitCode: null, signal: 9 });
  });

  it('keeps the replay after exit, so an attach still shows the scrollback', () => {
    const { pty, session } = makeSession();
    pty.emitData('build failed\r\n');
    pty.emitExit(2);
    expect(session.replay()).toStrictEqual({ replay: 'build failed\r\n', replayTruncated: false, seq: 1 });
  });

  it('mute stops data and exit events and frees the replay', () => {
    const { pty, session, data, exits } = makeSession();
    pty.emitData('kept?');
    session.mute();
    pty.emitData('late');
    pty.emitExit(0);
    expect(data).toHaveLength(1);
    expect(exits).toStrictEqual([]);
    expect(session.replay().replay).toBe('');
  });
});

describe('TerminalSession end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('SIGHUPs the shell, and resolves as soon as the exit is reported without closing the PTY', async () => {
    const { pty, session, checked } = makeSession();
    let done = false;
    const ended = session.end().then(() => {
      done = true;
    });
    // No close with the SIGHUP: the kernel's second hang-up would stop bash passing the first on to its jobs.
    expect(pty.calls).toStrictEqual(['SIGHUP']);
    expect(checked).toStrictEqual([4_242]);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS / 2);
    expect(pty.closeCount).toBe(0);
    expect(done).toBe(false);
    pty.emitExit(0, 1);
    await ended;
    expect(done).toBe(true);
    // No close and no SIGKILL, ever, even after the grace period (node-pty closes the device of an exited shell).
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 3);
    expect(pty.calls).toStrictEqual(['SIGHUP']);
  });

  it('after 1 s closes the PTY and SIGKILLs a shell that ignores SIGHUP, checking first that it is still our child', async () => {
    const { pty, session, checked } = makeSession();
    let done = false;
    const ended = session.end().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    expect(pty.calls).toStrictEqual(['SIGHUP']);
    await vi.advanceTimersByTimeAsync(1);
    expect(pty.calls).toStrictEqual(['SIGHUP', 'close', 'SIGKILL']);
    expect(checked).toStrictEqual([4_242, 4_242]);
    expect(done).toBe(false);
    pty.emitExit(0, 9);
    await ended;
    expect(done).toBe(true);
  });

  it('resolves the grace period after SIGKILL when the exit is never reported, and keeps the shell running', async () => {
    const { pty, session } = makeSession();
    let done = false;
    void session.end().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(pty.killSignals).toStrictEqual(['SIGHUP', 'SIGKILL']);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(session.running).toBe(true);
    expect(pty.killSignals).toStrictEqual(['SIGHUP', 'SIGKILL']);
  });

  it('skips the SIGKILL when the pid now has another parent', async () => {
    const harness = makeSession();
    const { pty, session, log } = harness;
    const ended = session.end();
    harness.ownChild = false;
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(pty.killSignals).toStrictEqual(['SIGHUP']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SIGKILL not sent'));
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    await ended;
    expect(pty.killSignals).toStrictEqual(['SIGHUP']);
  });

  it('skips the SIGHUP too when the pid is not our child, but still closes the PTY', async () => {
    const harness = makeSession();
    harness.ownChild = false;
    const ended = harness.session.end();
    expect(harness.pty.calls).toStrictEqual(['close']);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);
    await ended;
    expect(harness.pty.killSignals).toStrictEqual([]);
  });

  it('sends nothing at all once the exit has been reported, not even after the grace period', async () => {
    const { pty, session, checked } = makeSession();
    pty.emitExit(0);
    await session.end();
    session.killNow();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 3);
    expect(pty.calls).toStrictEqual([]);
    expect(checked).toStrictEqual([]);
  });

  it('sends no SIGKILL when the exit is reported during the grace period, however late', async () => {
    const { pty, session, checked } = makeSession();
    const ended = session.end();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    pty.emitExit(0, 1);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 3);
    await ended;
    expect(pty.killSignals).toStrictEqual(['SIGHUP']);
    expect(checked).toStrictEqual([4_242]);
  });

  it('is idempotent, refuses input and resizes once it has begun', async () => {
    const { pty, session } = makeSession();
    const first = session.end();
    expect(session.end()).toBe(first);
    session.write('ls\r');
    session.resize(100, 30);
    expect(pty.writes).toStrictEqual([]);
    expect(pty.resizes).toStrictEqual([]);
    pty.emitExit(0, 1);
    await first;
    expect(pty.calls).toStrictEqual(['SIGHUP']);
  });

  it('defaults to the one-second grace period from the plan', () => {
    expect(KILL_GRACE_MS).toBe(1_000);
  });

  it('killNow SIGKILLs a running shell at once, only when it is still our child', () => {
    const harness = makeSession();
    harness.session.killNow();
    expect(harness.pty.killSignals).toStrictEqual(['SIGKILL']);
    harness.ownChild = false;
    harness.session.killNow();
    expect(harness.pty.killSignals).toStrictEqual(['SIGKILL']);
  });

  it('a kill that throws (the shell is already gone) is swallowed', async () => {
    const { pty, session } = makeSession();
    pty.kill = () => {
      throw new Error('ESRCH');
    };
    pty.close = () => {
      throw new Error('EBADF');
    };
    const ended = session.end();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);
    await expect(ended).resolves.toBeUndefined();
  });
});
