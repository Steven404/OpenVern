// Sessions by chat id (docs/terminal-plan.md T1.3): create or attach, the session limit, close, replacement after
// exit, the starting folder and process lifetime. Driven by a fake PTY, so no real shell is ever spawned.

import { TERMINAL, type TerminalDataEvent, type TerminalExitEvent } from '@shared/terminal';
import { describe, expect, it } from 'vitest';
import { createFakeProcessTable } from './fake-processes';
import { createFakePty, type FakePty } from './fake-pty';
import {
  type OpenParams,
  type ShellCommand,
  TerminalLimitError,
  TerminalManager,
  type TerminalManagerDeps,
  TerminalShutdownError,
  TerminalSpawnLimitError,
} from './manager';
import type { PtySpawnOptions } from './pty';

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: PtySpawnOptions;
}

interface Harness {
  readonly manager: TerminalManager;
  readonly ptys: FakePty[];
  readonly spawns: SpawnCall[];
  readonly data: TerminalDataEvent[];
  readonly exits: TerminalExitEvent[];
}

const SHELL: ShellCommand = { file: '/bin/zsh', args: ['-l'], env: { TERM: 'xterm-256color', PATH: '/bin' } };

function makeManager(over: Partial<TerminalManagerDeps> = {}): Harness {
  const ptys: FakePty[] = [];
  const spawns: SpawnCall[] = [];
  const data: TerminalDataEvent[] = [];
  const exits: TerminalExitEvent[] = [];
  const manager = new TerminalManager({
    spawn: (file, args, options) => {
      spawns.push({ file, args, options });
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    },
    shell: () => SHELL,
    homeDir: () => '/home/me',
    isDirectory: () => true,
    events: { data: (event) => data.push(event), exit: (event) => exits.push(event) },
    killGraceMs: 1,
    ...over,
  });
  return { manager, ptys, spawns, data, exits };
}

function open(chatId: string, cwd: string | null = null, cols = 80, rows = 24): OpenParams {
  return { chatId, cwd, cols, rows };
}

function ptyAt(harness: Harness, index: number): FakePty {
  const pty = harness.ptys[index];
  if (!pty) throw new Error(`no PTY spawned at index ${index}`);
  return pty;
}

describe('TerminalManager.open', () => {
  it('starts a login shell in the requested folder with the terminal environment', async () => {
    const harness = makeManager();
    const result = await harness.manager.open(open('chat-1', '/project'));

    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]).toMatchObject({
      file: '/bin/zsh',
      args: ['-l'],
      options: {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: '/project',
        env: { TERM: 'xterm-256color', PATH: '/bin' },
      },
    });
    expect(result).toStrictEqual({
      info: {
        chatId: 'chat-1',
        shell: 'zsh',
        cwd: '/project',
        cols: 80,
        rows: 24,
        status: { state: 'running' },
      },
      snapshot: '',
      seq: 0,
      created: true,
    });
  });

  it('attaches a second open to the running session, with its snapshot and seq', async () => {
    const harness = makeManager();
    const first = await harness.manager.open(open('chat-1', '/project'));
    expect(first.created).toBe(true);

    ptyAt(harness, 0).emitData('one\r\n');
    ptyAt(harness, 0).emitData('two\r\n');

    const again = await harness.manager.open(open('chat-1', '/elsewhere', 120, 40));
    expect(again.created).toBe(false);
    expect(again.seq).toBe(2);
    expect(again.snapshot).toContain('one');
    expect(again.snapshot).toContain('two');
    // The requested folder and size are ignored: the session keeps its own.
    expect(again.info).toMatchObject({ chatId: 'chat-1', cwd: '/project', cols: 80, rows: 24 });
    expect(harness.spawns).toHaveLength(1);
  });

  it('refuses the 9th live session', async () => {
    const harness = makeManager();
    for (let index = 0; index < 8; index++) await harness.manager.open(open(`chat-${index}`));

    await expect(harness.manager.open(open('chat-8'))).rejects.toThrow(TerminalLimitError);
    await expect(harness.manager.open(open('chat-8'))).rejects.toThrow(/at most 8/i);
    expect(harness.spawns).toHaveLength(8);
    expect(harness.manager.size).toBe(8);
    // Attaching to a session that already exists is still fine at the limit.
    await expect(harness.manager.open(open('chat-0'))).resolves.toMatchObject({ created: false });
  });

  it('makes room for a new chat by dropping the oldest exited session', async () => {
    const harness = makeManager();
    for (let index = 0; index < 8; index++) await harness.manager.open(open(`chat-${index}`));

    ptyAt(harness, 3).emitExit(0);
    const result = await harness.manager.open(open('chat-8'));

    expect(result.created).toBe(true);
    expect(harness.manager.has('chat-3')).toBe(false);
    expect(harness.manager.has('chat-8')).toBe(true);
    expect(harness.manager.size).toBe(8);
  });

  it('starts a fresh shell when the chat’s shell has exited and restart is set', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitData('old output\r\n');
    ptyAt(harness, 0).emitExit(0);

    const fresh = await harness.manager.open({ ...open('chat-1'), restart: true });
    expect(fresh).toMatchObject({ created: true, snapshot: '', seq: 0 });
    expect(fresh.info.status).toStrictEqual({ state: 'running' });
    expect(harness.spawns).toHaveLength(2);
    expect(harness.manager.size).toBe(1);

    ptyAt(harness, 1).emitData('new output\r\n');
    expect(await harness.manager.read('chat-1', {})).toMatchObject({
      ok: true,
      result: { totalLines: 1, text: 'new output' },
    });
  });

  it('does not keep a session when the spawn throws', async () => {
    let fail = true;
    const manager = new TerminalManager({
      spawn: () => {
        if (fail) throw new Error('posix_spawnp failed.');
        return createFakePty();
      },
      shell: () => SHELL,
      homeDir: () => '/home/me',
      isDirectory: () => true,
      events: { data: () => {}, exit: () => {} },
    });

    await expect(manager.open(open('chat-1'))).rejects.toThrow('posix_spawnp failed.');
    expect(manager.size).toBe(0);
    expect(manager.has('chat-1')).toBe(false);

    fail = false;
    await expect(manager.open(open('chat-1'))).resolves.toMatchObject({ created: true });
    expect(manager.size).toBe(1);
  });
});

/** Lets pending promise callbacks and the 1 ms grace timers of `makeManager` run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('TerminalManager exited sessions and restart', () => {
  it('attaches to an exited session without restart, so its exit code and scrollback stay visible', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitData('build failed\r\n');
    ptyAt(harness, 0).emitExit(2);

    const again = await harness.manager.open(open('chat-1'));
    expect(again.created).toBe(false);
    expect(again.seq).toBe(1);
    expect(again.snapshot).toContain('build failed');
    expect(again.info.status).toStrictEqual({ state: 'exited', exitCode: 2, signal: null });
    expect(harness.spawns).toHaveLength(1);
  });

  it('ignores restart while the shell is running', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    const again = await harness.manager.open({ ...open('chat-1'), restart: true });
    expect(again.created).toBe(false);
    expect(harness.spawns).toHaveLength(1);
    expect(ptyAt(harness, 0).killSignals).toStrictEqual([]);
  });
});

describe('TerminalManager limits', () => {
  it('counts a closed shell that is still dying against maxSessions (the reviewer’s 20 open/close cycles)', async () => {
    // Fake shells never report an exit unless told: each one stays alive after its kill.
    const harness = makeManager({ maxSessions: 1 });
    await harness.manager.open(open('chat-1'));
    let refused = 0;
    for (let cycle = 0; cycle < 20; cycle++) {
      await harness.manager.close('chat-1');
      await harness.manager.open(open('chat-1')).catch((err: unknown) => {
        expect(err).toBeInstanceOf(TerminalLimitError);
        refused += 1;
      });
    }
    expect(refused).toBe(20);
    expect(harness.spawns).toHaveLength(1);
    expect(harness.manager.liveCount).toBe(1);

    // Once the shell is confirmed gone, the slot is free.
    ptyAt(harness, 0).emitExit(0, 9);
    await settle();
    expect(harness.manager.liveCount).toBe(0);
    await expect(harness.manager.open(open('chat-1'))).resolves.toMatchObject({ created: true });
    expect(harness.spawns).toHaveLength(2);
  });

  it('an exited session in the map still makes room for a new chat at the limit', async () => {
    const harness = makeManager({ maxSessions: 1 });
    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitExit(0);
    await expect(harness.manager.open(open('chat-2'))).resolves.toMatchObject({ created: true });
    expect(harness.manager.has('chat-1')).toBe(false);
  });

  it('refuses to start more than maxSpawnsPerRun shells in one run, with a message to restart the app', async () => {
    expect(TERMINAL.maxSpawnsPerRun).toBe(100);
    const harness = makeManager({ maxSpawnsPerRun: 3 });
    for (let index = 0; index < 3; index++) {
      await harness.manager.open(open(`chat-${index}`));
      ptyAt(harness, index).emitExit(0);
      await harness.manager.close(`chat-${index}`);
    }
    await settle();
    expect(harness.manager.liveCount).toBe(0);
    const refused = harness.manager.open(open('chat-3'));
    await expect(refused).rejects.toThrow(TerminalSpawnLimitError);
    await expect(harness.manager.open(open('chat-3'))).rejects.toThrow(/Restart OpenVern to open more terminals/);
    expect(harness.spawns).toHaveLength(3);
    expect(harness.manager.spawnCount).toBe(3);
  });

  it('counts a spawn that throws, since it may leak too', async () => {
    let calls = 0;
    const manager = new TerminalManager({
      spawn: () => {
        calls += 1;
        throw new Error('posix_spawnp failed.');
      },
      shell: () => SHELL,
      homeDir: () => '/home/me',
      isDirectory: () => true,
      events: { data: () => {}, exit: () => {} },
      maxSpawnsPerRun: 2,
    });
    await expect(manager.open(open('chat-1'))).rejects.toThrow('posix_spawnp');
    await expect(manager.open(open('chat-1'))).rejects.toThrow('posix_spawnp');
    await expect(manager.open(open('chat-1'))).rejects.toThrow(TerminalSpawnLimitError);
    expect(calls).toBe(2);
  });

  it('a restart at the limit reuses the exited session’s slot, even while another shell is dying', async () => {
    const harness = makeManager({ maxSessions: 2 });
    await harness.manager.open(open('a'));
    await harness.manager.open(open('b'));
    ptyAt(harness, 1).emitExit(1);
    await harness.manager.close('a'); // dying: still counted
    expect(harness.manager.liveCount).toBe(2);
    await expect(harness.manager.open({ ...open('b'), restart: true })).resolves.toMatchObject({ created: true });
    expect(harness.manager.liveCount).toBe(2);
    await expect(harness.manager.open(open('c'))).rejects.toThrow(TerminalLimitError);
  });

  it('does not end an exited session just to refuse a restart at the spawn limit', async () => {
    const harness = makeManager({ maxSpawnsPerRun: 1 });
    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitExit(1);
    await expect(harness.manager.open({ ...open('chat-1'), restart: true })).rejects.toThrow(TerminalSpawnLimitError);
    expect(harness.manager.has('chat-1')).toBe(true);
  });
});

describe('TerminalManager shutdown', () => {
  it('refuses opens once shutdown has begun, and accepts them again when it is called off', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    harness.manager.beginShutdown();
    expect(harness.manager.isShuttingDown).toBe(true);
    await expect(harness.manager.open(open('chat-2'))).rejects.toThrow(TerminalShutdownError);
    await expect(harness.manager.open(open('chat-1'))).rejects.toThrow(TerminalShutdownError);
    expect(harness.spawns).toHaveLength(1);

    harness.manager.endShutdown();
    await expect(harness.manager.open(open('chat-2'))).resolves.toMatchObject({ created: true });
  });
});

describe('TerminalManager process sessions', () => {
  it('close ends the processes in the shell’s session through the injected table and signal', async () => {
    const procs = createFakeProcessTable('linux');
    const harness = makeManager({ processTable: procs.table, signal: procs.signal });
    await harness.manager.open(open('chat-1'));
    const pid = ptyAt(harness, 0).pid;
    procs.add({ pid, start: '1', session: procs.keyOf(pid) });
    procs.add({ pid: 900, start: '2', session: procs.keyOf(pid), ignoresHup: true });
    await harness.manager.close('chat-1');
    await settle();
    expect(procs.signals).toStrictEqual([
      { pid: 900, signal: 'SIGHUP' },
      { pid: 900, signal: 'SIGKILL' },
    ]);
    expect(ptyAt(harness, 0).killSignals).toStrictEqual(['SIGHUP', 'SIGKILL']);
  });
});

describe('TerminalManager starting folder', () => {
  it('falls back to home when the folder is missing, not a directory, or absent', async () => {
    const harness = makeManager({ isDirectory: (path) => path === '/project' });
    await harness.manager.open(open('chat-1', '/project'));
    await harness.manager.open(open('chat-2', '/missing'));
    await harness.manager.open(open('chat-3', '/project/file.txt'));
    await harness.manager.open(open('chat-4', null));

    expect(harness.spawns.map((spawn) => spawn.options.cwd)).toStrictEqual([
      '/project',
      '/home/me',
      '/home/me',
      '/home/me',
    ]);
  });

  it('treats a relative folder as home even when it exists', async () => {
    const harness = makeManager({ isDirectory: () => true });
    await harness.manager.open(open('chat-1', 'relative/dir'));
    expect(harness.spawns[0]?.options.cwd).toBe('/home/me');
  });

  it('resolves the requested path before the directory check', async () => {
    const checked: string[] = [];
    const harness = makeManager({
      isDirectory: (path) => {
        checked.push(path);
        return path === '/project';
      },
    });
    await harness.manager.open(open('chat-1', '/project/../project'));
    expect(checked).toStrictEqual(['/project']);
    expect(harness.spawns[0]?.options.cwd).toBe('/project');
  });
});

describe('TerminalManager.close and lifetime', () => {
  it('close kills the shell and forgets the session', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));

    await expect(harness.manager.close('chat-1')).resolves.toBeUndefined();
    expect(harness.manager.has('chat-1')).toBe(false);
    expect(harness.manager.size).toBe(0);
    expect(ptyAt(harness, 0).killSignals).toStrictEqual(['SIGHUP']);
  });

  it('close resolves when the chat has no session', async () => {
    const harness = makeManager();
    await expect(harness.manager.close('never-open')).resolves.toBeUndefined();
    await harness.manager.open(open('chat-1'));
    await harness.manager.close('chat-1');
    await expect(harness.manager.close('chat-1')).resolves.toBeUndefined();
    expect(harness.spawns).toHaveLength(1);
  });

  it('ignores events from a closed session, even after the chat id is reused', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitData('first');
    await harness.manager.close('chat-1');

    // The old shell may still produce output and report its exit while it shuts down.
    ptyAt(harness, 0).emitData('late');
    ptyAt(harness, 0).emitExit(0, 15);
    expect(harness.data).toStrictEqual([{ chatId: 'chat-1', seq: 1, data: 'first' }]);
    expect(harness.exits).toStrictEqual([]);

    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 1).emitData('second');
    expect(harness.data).toStrictEqual([
      { chatId: 'chat-1', seq: 1, data: 'first' },
      { chatId: 'chat-1', seq: 1, data: 'second' },
    ]);
    expect(harness.exits).toStrictEqual([]);
  });

  it('disposeAll ends every session and waits for its shell', async () => {
    const harness = makeManager();
    for (let index = 0; index < 3; index++) await harness.manager.open(open(`chat-${index}`));

    await harness.manager.disposeAll();
    expect(harness.manager.size).toBe(0);
    for (let index = 0; index < 3; index++) expect(harness.manager.has(`chat-${index}`)).toBe(false);
    expect(harness.ptys.map((pty) => pty.killSignals)).toStrictEqual([
      ['SIGHUP', 'SIGKILL'],
      ['SIGHUP', 'SIGKILL'],
      ['SIGHUP', 'SIGKILL'],
    ]);
    for (const pty of harness.ptys) pty.emitData('late');
    expect(harness.data).toStrictEqual([]);
  });

  it('killAllNow SIGKILLs every session synchronously', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    await harness.manager.open(open('chat-2'));

    harness.manager.killAllNow();
    expect(harness.ptys.map((pty) => pty.killSignals)).toStrictEqual([['SIGKILL'], ['SIGKILL']]);
  });
});

describe('TerminalManager.read', () => {
  it('reads a running session and answers no_terminal without one', async () => {
    const harness = makeManager();
    expect(await harness.manager.read('chat-1', {})).toStrictEqual({ ok: false, reason: 'no_terminal' });

    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitData('hello\r\n');
    expect(await harness.manager.read('chat-1', {})).toMatchObject({
      ok: true,
      result: { totalLines: 1, startLine: 1, endLine: 1, text: 'hello' },
    });
  });

  it('still reads an exited session, and stops reading once it is closed', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitData('before exit\r\n');
    ptyAt(harness, 0).emitExit(0);

    expect(await harness.manager.read('chat-1', {})).toMatchObject({ ok: true, result: { text: 'before exit' } });

    await harness.manager.close('chat-1');
    expect(await harness.manager.read('chat-1', {})).toStrictEqual({ ok: false, reason: 'no_terminal' });
  });
});
