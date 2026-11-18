// A pending Review set is bound to the project it was made for: a stage records the turn's project, a stage from
// another project is refused, and Apply writes only when that project, the chat's current one and the one the client
// showed agree. Discard always works.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APPLY_PROJECT_CHANGED, PROPOSALS_OTHER_PROJECT } from '@shared/api';
import type { HunkDecision, PendingChanges } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { ensureDataDir } from '../storage/paths';
import { cleanupTempDirs, makeTempDir } from '../storage/test-helpers';
import { flush, gate } from './auto-test-helpers';
import { createChangesService } from './index';

cleanupTempDirs();

const CHAT = 'chat1';

async function setup(opts: { beforeWrite?: () => Promise<void> } = {}) {
  const base = await makeTempDir();
  const roots: Record<'A' | 'B', string> = { A: '', B: '' };
  for (const name of ['A', 'B'] as const) {
    await fs.mkdir(path.join(base, name));
    roots[name] = await fs.realpath(path.join(base, name));
  }
  const dataDir = (await ensureDataDir(path.join(base, 'data'))).root;
  const state = { current: 'A' as string | null };
  const svc = createChangesService({
    dataDir,
    chatProjectId: async () => state.current,
    ...(opts.beforeWrite ? { beforeWrite: opts.beforeWrite } : {}),
  });
  const tools = (project: 'A' | 'B', messageId = 'm1') =>
    svc.tools({
      chatId: CHAT,
      projectId: project,
      projectRoot: roots[project],
      messageId,
      turnId: 'u',
      mode: 'review',
    });
  const acceptAll = (p: PendingChanges | null) => {
    const decisions: Record<string, Record<string, HunkDecision>> = {};
    for (const f of p?.files ?? []) decisions[f.path] = Object.fromEntries(f.hunks.map((h) => [h.id, 'accepted']));
    return decisions;
  };
  /** Apply everything into `project` as the route does: `project` is the chat's current project. */
  const apply = async (project: 'A' | 'B', expectedProjectId?: string | null) => {
    const p = (await svc.get(CHAT)).pending;
    return svc.apply({
      chatId: CHAT,
      projectId: project,
      projectRoot: roots[project],
      ...(expectedProjectId !== undefined ? { expectedProjectId } : {}),
      revision: p?.revision ?? 0,
      decisions: acceptAll(p),
    });
  };
  const storeFile = path.join(dataDir, 'changes', `${CHAT}.json`);
  const stored = async () => JSON.parse(await fs.readFile(storeFile, 'utf8'));
  const list = async (project: 'A' | 'B') => (await fs.readdir(roots[project])).sort();
  return { svc, tools, apply, roots, state, stored, storeFile, list };
}

describe('the pending set is bound to its project', () => {
  it('the stage that starts a pending set records the turn’s project; emptying the set drops it', async () => {
    const s = await setup();
    await s.tools('A').stage('a.txt', 'a\n');
    expect((await s.stored()).pendingProjectId).toBe('A');
    // Created then deleted: a no-op, the set empties and the binding goes with it.
    await s.tools('A').stage('a.txt', null);
    expect((await s.svc.get(CHAT)).pending).toBeNull();
    expect(await s.stored()).not.toHaveProperty('pendingProjectId');
    // The next set binds afresh to its own turn's project.
    s.state.current = 'B';
    await s.tools('B').stage('b.txt', 'b\n');
    expect((await s.stored()).pendingProjectId).toBe('B');
  });

  it('a stage from another project into a non-empty set is refused and changes nothing', async () => {
    const s = await setup();
    await s.tools('A').stage('a.txt', 'a\n');
    const before = await s.stored();
    s.state.current = 'B';
    await expect(s.tools('B', 'm2').stage('b.txt', 'b\n')).rejects.toMatchObject({ code: 'conflict' });
    expect(await s.stored()).toEqual(before);
    // The turn that made the set may still add to it.
    await s.tools('A', 'm3').stage('c.txt', 'c\n');
    expect((await s.svc.get(CHAT)).pending?.files.map((f) => f.path)).toEqual(['a.txt', 'c.txt']);
  });
});

describe('apply checks the project under the store lock, before any write', () => {
  it('proposals made for A, chat now in B: refused, nothing written anywhere, the set stays pending', async () => {
    const s = await setup();
    await s.tools('A').stage('new.txt', 'hello\n');
    s.state.current = 'B';
    const before = await s.stored();
    for (const shown of [undefined, 'B', 'A', null] as const) {
      await expect(s.apply('B', shown)).rejects.toMatchObject({ code: 'conflict', message: PROPOSALS_OTHER_PROJECT });
    }
    expect(await s.list('A')).toEqual([]);
    expect(await s.list('B')).toEqual([]);
    expect(await s.stored()).toEqual(before);
    expect((await s.svc.get(CHAT)).pending?.files.map((f) => f.path)).toEqual(['new.txt']);
  });

  it('a stale shown project is refused with APPLY_PROJECT_CHANGED and writes nothing', async () => {
    const s = await setup();
    await s.tools('A').stage('new.txt', 'hello\n');
    const before = await s.stored();
    for (const shown of ['B', null] as const) {
      await expect(s.apply('A', shown)).rejects.toMatchObject({ code: 'conflict', message: APPLY_PROJECT_CHANGED });
    }
    expect(await s.list('A')).toEqual([]);
    expect(await s.stored()).toEqual(before);
  });

  it.each([
    ['shown project sent', 'A'],
    ['shown project omitted', undefined],
  ] as const)('everything agrees (%s): writes into the project and clears the binding', async (_, shown) => {
    const s = await setup();
    await s.tools('A').stage('new.txt', 'hello\n');
    expect((await s.stored()).pendingProjectId).toBe('A');
    const res = await s.apply('A', shown);
    expect(res.batch.written.map((f) => f.path)).toEqual(['new.txt']);
    expect(await fs.readFile(path.join(s.roots.A, 'new.txt'), 'utf8')).toBe('hello\n');
    expect(await s.list('B')).toEqual([]);
    expect(res.changes.pending).toBeNull();
    expect(await s.stored()).not.toHaveProperty('pendingProjectId');
  });

  it('an empty set is still a stale apply, whatever the projects', async () => {
    const s = await setup();
    await expect(s.apply('A', 'A')).rejects.toMatchObject({ code: 'changes_stale' });
  });
});

describe('a legacy unbound pending set counts as the chat’s current project', () => {
  /** A non-empty pending set as an older build stored it: no `pendingProjectId`. */
  async function legacy() {
    const s = await setup();
    await s.tools('A').stage('new.txt', 'hello\n');
    const { pendingProjectId, ...rest } = await s.stored();
    expect(pendingProjectId).toBe('A');
    await fs.writeFile(s.storeFile, JSON.stringify(rest));
    return s;
  }

  it('apply writes it into the chat’s current project, as older builds did', async () => {
    const s = await legacy();
    s.state.current = 'B';
    const res = await s.apply('B', 'B');
    expect(res.batch.written.map((f) => f.path)).toEqual(['new.txt']);
    expect(await fs.readFile(path.join(s.roots.B, 'new.txt'), 'utf8')).toBe('hello\n');
  });

  it('a stage from the current project binds it; a stage from another project is refused', async () => {
    const s = await legacy();
    s.state.current = 'B';
    await expect(s.tools('A', 'm2').stage('a.txt', 'a\n')).rejects.toMatchObject({ code: 'conflict' });
    expect(await s.stored()).not.toHaveProperty('pendingProjectId');
    await s.tools('B', 'm3').stage('b.txt', 'b\n');
    expect((await s.stored()).pendingProjectId).toBe('B');
  });
});

describe('retry snapshot/restore carries the binding', () => {
  it('restores the set with its project, so it is still refused in another project', async () => {
    const s = await setup();
    await s.tools('A').stage('a.txt', 'a\n');
    await s.svc.snapshot(CHAT, 'u2');
    expect((await s.stored()).snapshots.at(-1).projectId).toBe('A');
    // The set is discarded and a new one is made for B after a move; the retry brings back A's set.
    await s.svc.discard(CHAT);
    s.state.current = 'B';
    await s.tools('B', 'm2').stage('b.txt', 'b\n');
    expect((await s.stored()).pendingProjectId).toBe('B');
    await s.svc.restore(CHAT, 'u2');
    expect((await s.stored()).pendingProjectId).toBe('A');
    expect((await s.svc.get(CHAT)).pending?.files.map((f) => f.path)).toEqual(['a.txt']);
    await expect(s.apply('B', 'B')).rejects.toMatchObject({ code: 'conflict', message: PROPOSALS_OTHER_PROJECT });
    expect(await s.list('B')).toEqual([]);
  });

  it('a snapshot of an empty set restores to empty and unbound', async () => {
    const s = await setup();
    await s.svc.snapshot(CHAT, 'u2');
    await s.tools('A').stage('a.txt', 'a\n');
    expect((await s.stored()).pendingProjectId).toBe('A');
    await s.svc.restore(CHAT, 'u2');
    expect((await s.svc.get(CHAT)).pending).toBeNull();
    expect(await s.stored()).not.toHaveProperty('pendingProjectId');
  });
});

describe('discard always works', () => {
  it('discards proposals made for another project; nothing is written', async () => {
    const s = await setup();
    await s.tools('A').stage('new.txt', 'hello\n');
    s.state.current = 'B';
    const res = await s.svc.discard(CHAT);
    expect(res.pending).toBeNull();
    expect(await s.stored()).not.toHaveProperty('pendingProjectId');
    expect(await s.list('A')).toEqual([]);
    expect(await s.list('B')).toEqual([]);
    // The chat can now make proposals in B.
    await s.tools('B', 'm2').stage('b.txt', 'b\n');
    expect((await s.stored()).pendingProjectId).toBe('B');
  });
});

describe('apply reads the chat’s current project under the store lock', () => {
  it('the caller read A, the chat is in B by the time the lock is taken: refused, nothing written', async () => {
    const s = await setup();
    await s.tools('A').stage('new.txt', 'hello\n');
    const before = await s.stored();
    // What a route that read the chat before a move would hand in: A's id and A's folder.
    s.state.current = 'B';
    await expect(s.apply('A', 'A')).rejects.toMatchObject({ code: 'conflict', message: APPLY_PROJECT_CHANGED });
    s.state.current = null;
    await expect(s.apply('A', 'A')).rejects.toMatchObject({ code: 'conflict', message: APPLY_PROJECT_CHANGED });
    expect(await s.list('A')).toEqual([]);
    expect(await s.list('B')).toEqual([]);
    expect(await s.stored()).toEqual(before);
  });
});

describe('changeProject: a change of the chat’s project commits under the store lock', () => {
  it('waits for an Apply that is writing, then sees nothing pending', async () => {
    const hold = gate();
    const s = await setup({ beforeWrite: () => hold.hold() });
    await s.tools('A').stage('new.txt', 'hello\n');
    const applying = s.apply('A', 'A');
    await hold.entered;
    let seen: boolean | undefined;
    const moving = s.svc.changeProject(CHAT, async ({ pending }) => {
      seen = pending;
      s.state.current = 'B';
    });
    await flush();
    // Apply holds the store lock between its project check and its writes: the move hasn't run.
    expect(seen).toBeUndefined();
    expect(s.state.current).toBe('A');
    hold.open();
    await applying;
    await moving;
    expect(seen).toBe(false);
    expect(await fs.readFile(path.join(s.roots.A, 'new.txt'), 'utf8')).toBe('hello\n');
    expect(await s.list('B')).toEqual([]);
  });

  it('a stage waits for it, then binds to its own turn’s project, which Apply refuses in the new one', async () => {
    const s = await setup();
    let staging: Promise<unknown> | undefined;
    await s.svc.changeProject(CHAT, async ({ pending }) => {
      expect(pending).toBe(false);
      staging = s.tools('A').stage('new.txt', 'hello\n');
      await flush();
      s.state.current = 'B';
    });
    await staging;
    expect((await s.stored()).pendingProjectId).toBe('A');
    await expect(s.apply('B', 'B')).rejects.toMatchObject({ code: 'conflict', message: PROPOSALS_OTHER_PROJECT });
    expect(await s.list('B')).toEqual([]);
  });

  it('reports pending proposals; discard() drops them for the next note; no store file for a chat with none', async () => {
    const s = await setup();
    await s.svc.changeProject(CHAT, async ({ pending }) => {
      expect(pending).toBe(false);
    });
    await expect(fs.stat(s.storeFile)).rejects.toMatchObject({ code: 'ENOENT' });

    await s.tools('A').stage('new.txt', 'hello\n');
    await s.svc.changeProject(CHAT, async ({ pending, discard }) => {
      expect(pending).toBe(true);
      await discard();
    });
    expect((await s.svc.get(CHAT)).pending).toBeNull();
    const stored = await s.stored();
    expect(stored).not.toHaveProperty('pendingProjectId');
    expect(stored.events).toEqual([{ type: 'discarded', files: [{ path: 'new.txt', kind: 'create' }] }]);
  });

  it('a throw in commit after discard() keeps the discard (saved first) and rejects', async () => {
    const s = await setup();
    await s.tools('A').stage('new.txt', 'hello\n');
    await expect(
      s.svc.changeProject(CHAT, async ({ discard }) => {
        await discard();
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');
    expect((await s.svc.get(CHAT)).pending).toBeNull();
  });
});

describe('snapshots of an unbound set, and snapshots that name no project', () => {
  /** A non-empty pending set as an older build stored it: no `pendingProjectId`. */
  async function legacy() {
    const s = await setup();
    await s.tools('A').stage('new.txt', 'hello\n');
    const { pendingProjectId: _bound, ...rest } = await s.stored();
    await fs.writeFile(s.storeFile, JSON.stringify(rest));
    return s;
  }

  it('records the chat’s project at snapshot time, so a restore after a move is refused in the new project', async () => {
    const s = await legacy();
    await s.svc.snapshot(CHAT, 'u2');
    expect((await s.stored()).snapshots.at(-1).projectId).toBe('A');
    // The live set stays unbound: a direct Apply still writes it into the chat's current project.
    expect(await s.stored()).not.toHaveProperty('pendingProjectId');
    await s.svc.discard(CHAT);
    s.state.current = 'B';
    await s.svc.restore(CHAT, 'u2');
    expect((await s.stored()).pendingProjectId).toBe('A');
    await expect(s.apply('B', 'B')).rejects.toMatchObject({ code: 'conflict', message: PROPOSALS_OTHER_PROJECT });
    expect(await s.list('A')).toEqual([]);
    expect(await s.list('B')).toEqual([]);
  });

  it('a non-empty snapshot that names no project comes back bound to no project: Apply and stage refuse, Discard clears', async () => {
    const s = await legacy();
    await s.svc.snapshot(CHAT, 'u2');
    // An older build's snapshot: no project recorded.
    const store = await s.stored();
    delete store.snapshots.at(-1).projectId;
    await fs.writeFile(s.storeFile, JSON.stringify(store));
    await s.svc.discard(CHAT);

    for (const project of ['A', 'B'] as const) {
      s.state.current = project;
      await s.svc.restore(CHAT, 'u2');
      expect((await s.svc.get(CHAT)).pending?.files.map((f) => f.path)).toEqual(['new.txt']);
      await expect(s.apply(project, project)).rejects.toMatchObject({
        code: 'conflict',
        message: PROPOSALS_OTHER_PROJECT,
      });
      await expect(s.tools(project, 'm2').stage('b.txt', 'b\n')).rejects.toMatchObject({ code: 'conflict' });
      // A retry of a later turn snapshots it as it is: still bound to no project.
      await s.svc.snapshot(CHAT, 'u3');
      await s.svc.discard(CHAT);
      await s.svc.restore(CHAT, 'u3');
      await expect(s.apply(project, project)).rejects.toMatchObject({ message: PROPOSALS_OTHER_PROJECT });
      expect((await s.svc.discard(CHAT)).pending).toBeNull();
      expect(await s.stored()).not.toHaveProperty('pendingProjectId');
    }
    expect(await s.list('A')).toEqual([]);
    expect(await s.list('B')).toEqual([]);
    // Once discarded, the chat proposes again in its project.
    await s.tools('B', 'm4').stage('b.txt', 'b\n');
    expect((await s.stored()).pendingProjectId).toBe('B');
  });

  it('an unbound set snapshotted while the chat’s project can’t be read restores bound to no project', async () => {
    const s = await legacy();
    s.state.current = null;
    await s.svc.snapshot(CHAT, 'u2');
    expect((await s.stored()).snapshots.at(-1)).not.toHaveProperty('projectId');
    await s.svc.discard(CHAT);
    s.state.current = 'A';
    await s.svc.restore(CHAT, 'u2');
    await expect(s.apply('A', 'A')).rejects.toMatchObject({ message: PROPOSALS_OTHER_PROJECT });
    expect(await s.list('A')).toEqual([]);
  });
});
