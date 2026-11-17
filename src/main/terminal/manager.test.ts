// Sessions by chat id (docs/terminal-plan.md T1.3, T1.4): create or attach with a raw replay, list, the session and
// spawn limits, restart, close, the starting folder and shutdown. Driven by a fake PTY, so no real shell is spawned.

import { TERMINAL, type TerminalDataEvent, type TerminalExitEvent } from '@shared/terminal';
import { describe, expect, it } from 'vitest';
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
    documentsDir: () => '/home/me/Documents',
    isDirectory: () => true,
    events: { data: (event) => data.push(event), exit: (event) => exits.push(event) },
    isOwnChild: () => true,
    killGraceMs: 1,
    log: () => {},
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
      replay: '',
      replayTruncated: false,
      seq: 0,
      created: true,
    });
  });

  it('attaches a second open to the running session, with its raw replay and seq', async () => {
    const harness = makeManager();
    const first = await harness.manager.open(open('chat-1', '/project'));
    expect(first.created).toBe(true);

    ptyAt(harness, 0).emitData('one\r\n');
    ptyAt(harness, 0).emitData('two\r\n');

    const again = await harness.manager.open(open('chat-1', '/elsewhere', 120, 40));
    expect(again.created).toBe(false);
    expect(again.seq).toBe(2);
    expect(again.replay).toBe('one\r\ntwo\r\n');
    expect(again.replayTruncated).toBe(false);
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
    expect(fresh).toMatchObject({ created: true, replay: '', replayTruncated: false, seq: 0 });
    expect(fresh.info.status).toStrictEqual({ state: 'running' });
    expect(harness.spawns).toHaveLength(2);
    expect(harness.manager.size).toBe(1);

    ptyAt(harness, 1).emitData('new output\r\n');
    expect(await harness.manager.open(open('chat-1'))).toMatchObject({ replay: 'new output\r\n', seq: 1 });
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
      documentsDir: () => null,
      isDirectory: () => true,
      events: { data: () => {}, exit: () => {} },
      isOwnChild: () => true,
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
    expect(again.replay).toBe('build failed\r\n');
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
      documentsDir: () => null,
      isDirectory: () => true,
      events: { data: () => {}, exit: () => {} },
      isOwnChild: () => true,
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

  it('at the limit with a shell still dying, drops the oldest exited session before refusing', async () => {
    const harness = makeManager({ maxSessions: 3 });
    await harness.manager.open(open('a'));
    await harness.manager.open(open('b'));
    await harness.manager.open(open('c'));
    ptyAt(harness, 1).emitExit(0);
    ptyAt(harness, 2).emitExit(0);
    await harness.manager.close('a'); // ignores SIGHUP and SIGKILL in this fake: still dying
    expect(harness.manager.liveCount).toBe(3);

    await expect(harness.manager.open(open('d'))).resolves.toMatchObject({ created: true });
    expect(harness.manager.list().map((info) => info.chatId)).toStrictEqual(['c', 'd']);
    await expect(harness.manager.open(open('e'))).resolves.toMatchObject({ created: true });
    expect(harness.manager.list().map((info) => info.chatId)).toStrictEqual(['d', 'e']);
    // Nothing exited is left to drop, and the dying shell still holds its slot.
    await expect(harness.manager.open(open('f'))).rejects.toThrow(TerminalLimitError);
    ptyAt(harness, 0).emitExit(0, 9);
    await settle();
    await expect(harness.manager.open(open('f'))).resolves.toMatchObject({ created: true });
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

  it('starts in Documents when asked for it with no folder', async () => {
    const checked: string[] = [];
    const harness = makeManager({
      isDirectory: (path) => {
        checked.push(path);
        return true;
      },
    });
    await harness.manager.open({ ...open('__draft__'), defaultFolder: 'documents' });
    expect(checked).toStrictEqual(['/home/me/Documents']);
    expect(harness.spawns[0]?.options.cwd).toBe('/home/me/Documents');
  });

  it('resolves the Documents path before the directory check', async () => {
    const checked: string[] = [];
    const harness = makeManager({
      documentsDir: () => '/home/me/x/../Documents',
      isDirectory: (path) => {
        checked.push(path);
        return path === '/home/me/Documents';
      },
    });
    await harness.manager.open({ ...open('__draft__'), defaultFolder: 'documents' });
    expect(checked).toStrictEqual(['/home/me/Documents']);
    expect(harness.spawns[0]?.options.cwd).toBe('/home/me/Documents');
  });

  it('falls back to home when Documents is unknown, throws, is relative, empty or not a directory', async () => {
    const cases: Array<Partial<TerminalManagerDeps>> = [
      { documentsDir: () => null },
      {
        documentsDir: () => {
          throw new Error('getPath failed');
        },
      },
      { documentsDir: () => 'Documents' },
      { documentsDir: () => '' },
      { isDirectory: (path) => path !== '/home/me/Documents' },
    ];
    for (const over of cases) {
      const harness = makeManager(over);
      await harness.manager.open({ ...open('__draft__'), defaultFolder: 'documents' });
      expect(harness.spawns[0]?.options.cwd).toBe('/home/me');
    }
  });

  it('still starts in home with no folder and no defaultFolder, without looking up Documents', async () => {
    let asked = 0;
    const harness = makeManager({
      documentsDir: () => {
        asked += 1;
        return '/home/me/Documents';
      },
    });
    await harness.manager.open(open('chat-1', null));
    expect(harness.spawns[0]?.options.cwd).toBe('/home/me');
    expect(asked).toBe(0);
  });

  it('ignores defaultFolder when attaching to an existing session', async () => {
    const harness = makeManager();
    await harness.manager.open(open('__draft__', null));
    const again = await harness.manager.open({ ...open('__draft__'), defaultFolder: 'documents' });
    expect(again).toMatchObject({ created: false, info: { cwd: '/home/me' } });
    expect(harness.spawns).toHaveLength(1);
  });
});

describe('TerminalManager.adopt', () => {
  it('moves a running session to the chat: has, list and later events use the new id', async () => {
    const harness = makeManager();
    await harness.manager.open({ ...open('__draft__'), defaultFolder: 'documents' });
    ptyAt(harness, 0).emitData('before\r\n');

    expect(harness.manager.adopt('__draft__', 'chat-1')).toBe(true);
    expect(harness.manager.has('__draft__')).toBe(false);
    expect(harness.manager.has('chat-1')).toBe(true);
    expect(harness.manager.list()).toStrictEqual([
      {
        chatId: 'chat-1',
        shell: 'zsh',
        cwd: '/home/me/Documents',
        cols: 80,
        rows: 24,
        status: { state: 'running' },
      },
    ]);

    ptyAt(harness, 0).emitData('after\r\n');
    ptyAt(harness, 0).emitExit(0);
    expect(harness.data).toStrictEqual([
      { chatId: '__draft__', seq: 1, data: 'before\r\n' },
      { chatId: 'chat-1', seq: 2, data: 'after\r\n' },
    ]);
    expect(harness.exits).toStrictEqual([{ chatId: 'chat-1', status: { state: 'exited', exitCode: 0, signal: null } }]);
  });

  it('write, resize and close work under the new id and do nothing under the old one', async () => {
    const harness = makeManager({ killGraceMs: 10_000 });
    await harness.manager.open(open('__draft__'));
    harness.manager.adopt('__draft__', 'chat-1');
    const pty = ptyAt(harness, 0);

    harness.manager.write('__draft__', 'nope\r');
    harness.manager.resize('__draft__', 100, 30);
    await harness.manager.close('__draft__');
    expect(pty.writes).toStrictEqual([]);
    expect(pty.resizes).toStrictEqual([]);
    expect(pty.calls).toStrictEqual([]);

    harness.manager.write('chat-1', 'ls\r');
    harness.manager.resize('chat-1', 100, 30);
    expect(pty.writes).toStrictEqual(['ls\r']);
    expect(pty.resizes).toStrictEqual([{ cols: 100, rows: 30 }]);

    const closed = harness.manager.close('chat-1');
    expect(pty.calls).toStrictEqual(['SIGHUP']);
    pty.emitExit(0, 1);
    await closed;
    expect(harness.manager.liveCount).toBe(0);
  });

  it('an open of the chat attaches with the same replay and seq; an open of the draft starts a fresh shell', async () => {
    const harness = makeManager();
    await harness.manager.open(open('__draft__', '/project'));
    ptyAt(harness, 0).emitData('one\r\n');
    ptyAt(harness, 0).emitData('two\r\n');
    harness.manager.adopt('__draft__', 'chat-1');

    const attached = await harness.manager.open(open('chat-1'));
    expect(attached).toMatchObject({
      created: false,
      replay: 'one\r\ntwo\r\n',
      seq: 2,
      info: { chatId: 'chat-1', cwd: '/project' },
    });

    const fresh = await harness.manager.open(open('__draft__'));
    expect(fresh).toMatchObject({ created: true, replay: '', seq: 0, info: { chatId: '__draft__' } });
    expect(harness.spawns).toHaveLength(2);
  });

  it('refuses, changing nothing, when the chat already has a session', async () => {
    const harness = makeManager();
    await harness.manager.open(open('__draft__'));
    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitData('draft\r\n');
    ptyAt(harness, 1).emitData('chat\r\n');

    expect(harness.manager.adopt('__draft__', 'chat-1')).toBe(false);
    expect(harness.manager.list().map((info) => info.chatId)).toStrictEqual(['__draft__', 'chat-1']);
    expect(await harness.manager.open(open('__draft__'))).toMatchObject({ created: false, replay: 'draft\r\n' });
    expect(await harness.manager.open(open('chat-1'))).toMatchObject({ created: false, replay: 'chat\r\n' });
    expect(harness.ptys.map((pty) => pty.calls)).toStrictEqual([[], []]);
  });

  it('refuses when there is nothing to move, including a draft shell that is being closed', async () => {
    const harness = makeManager({ killGraceMs: 10_000 });
    expect(harness.manager.adopt('__draft__', 'chat-1')).toBe(false);

    await harness.manager.open(open('__draft__'));
    const closing = harness.manager.close('__draft__');
    expect(harness.manager.adopt('__draft__', 'chat-1')).toBe(false);
    expect(harness.manager.has('chat-1')).toBe(false);
    ptyAt(harness, 0).emitExit(0, 1);
    await closing;
  });

  it('refuses moving a session onto its own id', async () => {
    const harness = makeManager();
    await harness.manager.open(open('__draft__'));
    expect(harness.manager.adopt('__draft__', '__draft__')).toBe(false);
    expect(harness.manager.has('__draft__')).toBe(true);
  });

  it('moves an exited session with its status and output', async () => {
    const harness = makeManager();
    await harness.manager.open(open('__draft__'));
    ptyAt(harness, 0).emitData('bye\r\n');
    ptyAt(harness, 0).emitExit(3);

    expect(harness.manager.adopt('__draft__', 'chat-1')).toBe(true);
    expect(await harness.manager.open(open('chat-1'))).toMatchObject({
      created: false,
      replay: 'bye\r\n',
      info: { chatId: 'chat-1', status: { state: 'exited', exitCode: 3, signal: null } },
    });
  });

  it('never spawns: the session and spawn counts are unchanged', async () => {
    const harness = makeManager();
    await harness.manager.open(open('__draft__'));
    await harness.manager.open(open('other'));
    const before = { live: harness.manager.liveCount, spawned: harness.manager.spawnCount };

    harness.manager.adopt('__draft__', 'chat-1');
    expect({ live: harness.manager.liveCount, spawned: harness.manager.spawnCount }).toStrictEqual(before);
    expect(harness.spawns).toHaveLength(2);
  });
});

describe('TerminalManager.close and lifetime', () => {
  it('close hangs up the shell, forgets the session, and resolves once the exit is reported', async () => {
    const harness = makeManager({ killGraceMs: 10_000 });
    await harness.manager.open(open('chat-1'));

    let done = false;
    const closed = harness.manager.close('chat-1').then(() => {
      done = true;
    });
    expect(harness.manager.has('chat-1')).toBe(false);
    expect(harness.manager.size).toBe(0);
    expect(harness.manager.list()).toStrictEqual([]);
    expect(ptyAt(harness, 0).calls).toStrictEqual(['SIGHUP']);
    await settle();
    expect(done).toBe(false);
    ptyAt(harness, 0).emitExit(0, 1);
    await closed;
    expect(ptyAt(harness, 0).killSignals).toStrictEqual(['SIGHUP']);
    expect(harness.manager.liveCount).toBe(0);
  });

  it('close of a shell that ignores SIGHUP resolves after the SIGKILL and its grace period', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    await harness.manager.close('chat-1');
    expect(ptyAt(harness, 0).calls).toStrictEqual(['SIGHUP', 'close', 'SIGKILL']);
  });

  it('close never SIGKILLs a pid that is no longer our child', async () => {
    const checked: number[] = [];
    let ours = true;
    const harness = makeManager({
      isOwnChild: (pid) => {
        checked.push(pid);
        return ours;
      },
    });
    await harness.manager.open(open('chat-1'));
    const closed = harness.manager.close('chat-1');
    ours = false; // reaped and reused by an unrelated process before the delayed SIGKILL
    await closed;
    expect(ptyAt(harness, 0).killSignals).toStrictEqual(['SIGHUP']);
    expect(checked).toStrictEqual([4_242, 4_242]);
    // It still counts until node-pty reports the exit.
    expect(harness.manager.liveCount).toBe(1);
    ptyAt(harness, 0).emitExit(0);
    await settle();
    expect(harness.manager.liveCount).toBe(0);
  });

  it('close of an exited session sends nothing', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitExit(0);
    await harness.manager.close('chat-1');
    expect(ptyAt(harness, 0).calls).toStrictEqual([]);
    expect(harness.manager.liveCount).toBe(0);
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

  it('disposeAll resolves as soon as every shell has reported its exit', async () => {
    const harness = makeManager({ killGraceMs: 10_000 });
    await harness.manager.open(open('chat-1'));
    await harness.manager.open(open('chat-2'));
    const disposed = harness.manager.disposeAll();
    for (const pty of harness.ptys) pty.emitExit(0, 1);
    await disposed;
    expect(harness.ptys.map((pty) => pty.calls)).toStrictEqual([['SIGHUP'], ['SIGHUP']]);
    expect(harness.manager.liveCount).toBe(0);
  });

  it('disposeAll also waits for shells closed earlier that are still dying', async () => {
    const harness = makeManager({ killGraceMs: 10_000 });
    await harness.manager.open(open('chat-1'));
    void harness.manager.close('chat-1');
    let done = false;
    const disposed = harness.manager.disposeAll().then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    ptyAt(harness, 0).emitExit(0, 1);
    await disposed;
    expect(done).toBe(true);
  });

  it('killAllNow SIGKILLs every running shell that is still ours, synchronously', async () => {
    const pids = [1, 2, 7];
    const ptys: FakePty[] = [];
    const manager = new TerminalManager({
      spawn: () => {
        const pty = createFakePty(pids[ptys.length]);
        ptys.push(pty);
        return pty;
      },
      shell: () => SHELL,
      homeDir: () => '/home/me',
      documentsDir: () => null,
      isDirectory: () => true,
      events: { data: () => {}, exit: () => {} },
      isOwnChild: (pid) => pid !== 7,
      log: () => {},
    });
    await manager.open(open('chat-1'));
    await manager.open(open('chat-2'));
    await manager.open(open('chat-3'));
    ptys[1]?.emitExit(0);

    manager.killAllNow();
    expect(ptys.map((pty) => pty.killSignals)).toStrictEqual([['SIGKILL'], [], []]);
  });
});

describe('TerminalManager.list', () => {
  it('lists every session held, running or exited, oldest first, and not the ones closed', async () => {
    const harness = makeManager();
    expect(harness.manager.list()).toStrictEqual([]);
    await harness.manager.open(open('a', '/project'));
    await harness.manager.open(open('b'));
    await harness.manager.open(open('c'));
    ptyAt(harness, 1).emitExit(4);
    harness.manager.resize('a', 100, 30);
    void harness.manager.close('c');

    expect(harness.manager.list()).toStrictEqual([
      { chatId: 'a', shell: 'zsh', cwd: '/project', cols: 100, rows: 30, status: { state: 'running' } },
      {
        chatId: 'b',
        shell: 'zsh',
        cwd: '/home/me',
        cols: 80,
        rows: 24,
        status: { state: 'exited', exitCode: 4, signal: null },
      },
    ]);
  });

  it('returns copies, so a caller cannot change a session through them', async () => {
    const harness = makeManager();
    await harness.manager.open(open('a'));
    const [info] = harness.manager.list();
    if (!info) throw new Error('no session listed');
    info.cols = 1;
    info.status = { state: 'exited', exitCode: 0, signal: null };
    expect(harness.manager.list()[0]).toMatchObject({ cols: 80, status: { state: 'running' } });
  });
});

describe('TerminalManager replay on attach', () => {
  it('the replay and seq agree exactly with the events, with output interleaved between attaches', async () => {
    const harness = makeManager();
    await harness.manager.open(open('chat-1'));
    const pty = ptyAt(harness, 0);
    const events = () => harness.data.filter((event) => event.chatId === 'chat-1');
    const upTo = (seq: number) =>
      events()
        .filter((event) => event.seq <= seq)
        .map((event) => event.data)
        .join('');

    const pieces = ['$ ', 'e', 'cho hi', '\r\n', 'hi\r\n', '\x1b[1;32m$ \x1b[0m'];
    for (const piece of pieces) {
      // An attach started, then output, then the attach's result is used: it must reflect the moment it was made.
      const pending = harness.manager.open(open('chat-1'));
      pty.emitData(piece);
      const result = await pending;
      expect(result.replay).toBe(upTo(result.seq));
      expect(result.seq).toBe(events().length - 1);
      // The renderer drops events at or below seq; what is left continues the replay exactly.
      const rest = events()
        .filter((event) => event.seq > result.seq)
        .map((event) => event.data)
        .join('');
      expect(result.replay + rest).toBe(upTo(Number.MAX_SAFE_INTEGER));
    }
  });

  it('a truncated replay starts at a line start and says so', async () => {
    const harness = makeManager({ replayMaxBytes: 16 });
    await harness.manager.open(open('chat-1'));
    ptyAt(harness, 0).emitData('first line\r\nsecond line\r\n$ ');
    const result = await harness.manager.open(open('chat-1'));
    expect(result).toMatchObject({ replay: 'second line\r\n$ ', replayTruncated: true, seq: 1, created: false });
  });

  it('clearReplays drops every session’s output and keeps every shell running', async () => {
    const harness = makeManager();
    await harness.manager.open(open('a'));
    await harness.manager.open(open('b'));
    ptyAt(harness, 0).emitData('\x1b[that crashed the renderer\r\n');
    ptyAt(harness, 1).emitData('other\r\n');
    ptyAt(harness, 1).emitExit(0);

    harness.manager.clearReplays();
    for (const chatId of ['a', 'b']) {
      expect(await harness.manager.open(open(chatId))).toMatchObject({ replay: '', replayTruncated: true, seq: 1 });
    }
    expect(harness.ptys.map((pty) => pty.calls)).toStrictEqual([[], []]);
    expect(harness.manager.list().map((info) => info.status.state)).toStrictEqual(['running', 'exited']);
    ptyAt(harness, 0).emitData('$ ls\r\nafter\r\n');
    expect(await harness.manager.open(open('a'))).toMatchObject({ replay: 'after\r\n', seq: 2 });
  });
});
