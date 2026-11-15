// The own-child check made right before a shell is signalled (docs/terminal-plan.md T1.4). The parsers and the check
// are tested with injected lookups; one test asks the real platform about a real child, without signalling it.

import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createIsOwnChild, parseProcStatParent, parsePsParent } from './own-child';

describe('parseProcStatParent', () => {
  it('reads the parent pid after the command name', () => {
    expect(parseProcStatParent('4242 (zsh) S 100 4242 4242 34816 4242 4194560 ...')).toBe(100);
  });

  it('copes with spaces and parentheses in the command name', () => {
    expect(parseProcStatParent('4242 (a) b (c d) R 77 4242 4242 0 -1 ...')).toBe(77);
  });

  it('answers null for anything else', () => {
    for (const text of ['', 'garbage', '4242 (zsh)', '4242 (zsh) S', '4242 (zsh) S x 1']) {
      expect(parseProcStatParent(text)).toBeNull();
    }
  });
});

describe('parsePsParent', () => {
  it('reads one padded number', () => {
    expect(parsePsParent('  501\n')).toBe(501);
    expect(parsePsParent('1')).toBe(1);
  });

  it('answers null for empty or odd output', () => {
    for (const text of ['', '\n', 'PPID\n 1\n', '-1', '1 2', 'abc']) expect(parsePsParent(text)).toBeNull();
  });
});

describe('createIsOwnChild', () => {
  it('is true only when the parent is this process', () => {
    const parents = new Map([
      [10, 1_000],
      [11, 999],
    ]);
    const isOwnChild = createIsOwnChild('linux', (pid) => parents.get(pid) ?? null, 1_000);
    expect(isOwnChild(10)).toBe(true);
    expect(isOwnChild(11)).toBe(false);
    expect(isOwnChild(12)).toBe(false);
  });

  it('never asks about pids that would name a process group or nothing', () => {
    const asked: number[] = [];
    const isOwnChild = createIsOwnChild(
      'linux',
      (pid) => {
        asked.push(pid);
        return 1_000;
      },
      1_000,
    );
    for (const pid of [0, -1, -4242, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(isOwnChild(pid)).toBe(false);
    expect(asked).toStrictEqual([]);
  });

  it('answers false when the lookup throws', () => {
    const isOwnChild = createIsOwnChild(
      'darwin',
      () => {
        throw new Error('spawn /bin/ps ENOENT');
      },
      1_000,
    );
    expect(isOwnChild(10)).toBe(false);
  });

  it('answers false on a platform without a check', () => {
    expect(createIsOwnChild('win32')(process.pid)).toBe(false);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'tells a real child from a process that is not one, and a child that has gone',
    async () => {
      const isOwnChild = createIsOwnChild();
      const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
      try {
        const pid = child.pid;
        if (pid === undefined) throw new Error('sleep did not start');
        expect(isOwnChild(pid)).toBe(true);
        // This process is a child of something else, and pid 1 of nothing.
        expect(isOwnChild(process.pid)).toBe(false);
        expect(isOwnChild(1)).toBe(false);
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
        // Reaped by Node: no longer a process at all.
        expect(isOwnChild(pid)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
  );
});
