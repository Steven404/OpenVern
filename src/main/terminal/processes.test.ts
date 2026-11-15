// Reading the process table (macOS `ps`, Linux `/proc`) and the rules for which processes are in a terminal's
// session (docs/terminal-plan.md §2, "Ending a terminal"). No process is started: `ps` output and `/proc` are fixtures.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeProcessTable } from './fake-processes';
import {
  createProcessTable,
  createProcProcessTable,
  parseProcStat,
  parsePsOutput,
  SessionProcesses,
} from './processes';

describe('parsePsOutput (macOS)', () => {
  it('reads pid, controlling terminal and start time, with no terminal as null', () => {
    const text = [
      '    1      ?? Thu Oct  8 13:12:34 2026',
      '64213    16/0 Sun Nov 15 18:29:43 2026',
      '64215      ?? Sun Nov 15 18:29:44 2026   ',
      'garbage',
      '',
    ].join('\n');
    expect(parsePsOutput(text)).toStrictEqual([
      { pid: 1, start: 'Thu Oct  8 13:12:34 2026', session: null },
      { pid: 64213, start: 'Sun Nov 15 18:29:43 2026', session: 'tty:16/0' },
      { pid: 64215, start: 'Sun Nov 15 18:29:44 2026', session: null },
    ]);
  });
});

describe('parseProcStat (Linux)', () => {
  it('counts fields from the last parenthesis, so a command name with spaces and parentheses is safe', () => {
    const fields = ['S', '1', '700', '4242', '34816', '700', '4194560'];
    const rest = [...fields, ...Array(12).fill('0'), '123456', '8000000'];
    expect(parseProcStat(701, `701 (my (odd) cmd) ${rest.join(' ')}`)).toStrictEqual({
      pid: 701,
      start: '123456',
      session: 'sid:4242',
    });
  });

  it('refuses a malformed line', () => {
    expect(parseProcStat(1, 'nonsense')).toBeNull();
    expect(parseProcStat(1, '1 (x) S 0')).toBeNull();
  });
});

describe('createProcProcessTable', () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function statLine(pid: number, session: number, start: number): string {
    return `${pid} (sleep) S 1 ${pid} ${session} 0 -1 0 ${Array(12).fill('0').join(' ')} ${start} 0`;
  }

  it('lists every numeric entry, async and sync, and skips the rest', async () => {
    root = mkdtempSync(join(tmpdir(), 'openvern-proc-'));
    for (const [pid, session, start] of [
      [4242, 4242, 100],
      [500, 4242, 200],
    ] as const) {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), 'stat'), statLine(pid, session, start));
    }
    mkdirSync(join(root, 'self'));
    mkdirSync(join(root, '999')); // exited while listing: no stat file
    const table = createProcProcessTable(root);
    const expected = [
      { pid: 4242, start: '100', session: 'sid:4242' },
      { pid: 500, start: '200', session: 'sid:4242' },
    ];
    const sort = (list: { pid: number }[]) => [...list].sort((a, b) => a.pid - b.pid);
    expect(sort(await table.list())).toStrictEqual(sort(expected));
    expect(sort(table.listSync())).toStrictEqual(sort(expected));
    expect(table.leaderKey(4242)).toBe('sid:4242');
    expect(table.keyOutlivesLeader).toBe(true);
  });
});

describe('createProcessTable', () => {
  it('uses ps on macOS, /proc on Linux, and nothing elsewhere', () => {
    expect(createProcessTable('darwin')?.keyOutlivesLeader).toBe(false);
    expect(createProcessTable('linux')?.keyOutlivesLeader).toBe(true);
    expect(createProcessTable('win32')).toBeNull();
  });
});

describe('SessionProcesses.members', () => {
  it('excludes the shell itself and processes in other sessions', () => {
    const fake = createFakeProcessTable('linux');
    const procs = new SessionProcesses(4242, fake.table);
    const found = procs.members([
      { pid: 4242, start: '1', session: 'sid:4242' },
      { pid: 500, start: '2', session: 'sid:4242' },
      { pid: 501, start: '3', session: 'sid:501' },
      { pid: 502, start: '4', session: null },
    ]);
    expect(found.map((entry) => entry.pid)).toStrictEqual([500]);
  });

  it('on macOS, leaves a process that moved to its own session while the shell is alive', () => {
    const fake = createFakeProcessTable('darwin');
    const procs = new SessionProcesses(4242, fake.table);
    const tty = 'tty:16/3';
    expect(
      procs.members([
        { pid: 4242, start: 'a', session: tty },
        { pid: 500, start: 'b', session: tty },
      ]),
    ).toHaveLength(1);
    // 500 calls setsid: it loses the terminal while the shell still has it.
    expect(
      procs.members([
        { pid: 4242, start: 'a', session: tty },
        { pid: 500, start: 'b', session: null },
      ]),
    ).toStrictEqual([]);
  });

  it('on macOS, learns the session from the shell and finds nothing without it', () => {
    const fake = createFakeProcessTable('darwin');
    const procs = new SessionProcesses(4242, fake.table);
    // Before the shell has its terminal (spawn-helper not done yet), nothing is claimed.
    expect(
      procs.members([
        { pid: 4242, start: 'a', session: null },
        { pid: 500, start: 'b', session: null },
      ]),
    ).toStrictEqual([]);
  });

  it('does not trust a shell entry whose start time changed (a reused pid)', () => {
    const fake = createFakeProcessTable('darwin');
    const procs = new SessionProcesses(4242, fake.table);
    procs.members([{ pid: 4242, start: 'a', session: 'tty:16/3' }]);
    // Same pid, different process, on another terminal: its processes are not ours.
    expect(
      procs.members([
        { pid: 4242, start: 'z', session: 'tty:16/9' },
        { pid: 900, start: 'y', session: 'tty:16/9' },
      ]),
    ).toStrictEqual([]);
  });

  it('returns nothing without a process table or a snapshot', () => {
    expect(new SessionProcesses(4242, null).members([{ pid: 1, start: 'a', session: 'sid:4242' }])).toStrictEqual([]);
    expect(new SessionProcesses(4242, createFakeProcessTable('linux').table).members(null)).toStrictEqual([]);
  });
});
