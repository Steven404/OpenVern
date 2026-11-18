import type { AppliedBatch, ChatChanges, PendingChanges } from '@shared/types';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/query-keys';
import { installDomStubs, renderWithProviders } from '../composer/test-utils';
import { useRefreshProjectFiles } from './queries';

beforeAll(installDomStubs);
afterEach(cleanup);

const CHAT = 'chat-1';
const PROJECT = 'proj-1';

function Probe({ projectId }: { projectId: string | null | undefined }) {
  useRefreshProjectFiles(CHAT, projectId);
  return null;
}

const batch = (i: number): AppliedBatch => ({
  id: `b${i}`,
  appliedAt: '2026-01-01T00:00:00.000Z',
  messageId: 'm1',
  written: [],
  rejectedHunks: 0,
  skippedHunks: 0,
  conflicts: [],
  source: 'auto',
  undoable: false,
});

const applied = (n: number) => Array.from({ length: n }, (_, i) => batch(i));
const pending = (revision: number): PendingChanges => ({
  revision,
  messageId: 'm1',
  files: [],
  totalAdd: 0,
  totalDel: 0,
});
const changes = (diskSeq: number, over: Partial<ChatChanges> = {}): ChatChanges => ({
  pending: null,
  applied: [],
  diskSeq,
  ...over,
});

/** Mounts the hook with the chat's changes already cached, then forgets the invalidations the mount itself made. */
async function setup(initial: ChatChanges, opts: { projectId?: string | null } = { projectId: PROJECT }) {
  const projectId = opts.projectId;
  const view = renderWithProviders(<Probe projectId={projectId} />);
  // The query client tells its observers on a later tick, so every write waits one.
  const push = (next: ChatChanges) =>
    act(async () => {
      view.queryClient.setQueryData(queryKeys.chatChanges(CHAT), next);
      await new Promise((r) => setTimeout(r, 0));
    });
  await push(initial);
  const spy = vi.spyOn(view.queryClient, 'invalidateQueries');
  spy.mockClear();
  const keys = () => spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
  return { ...view, spy, push, keys };
}

function Switcher() {
  const [project, setProject] = useState(PROJECT);
  return (
    <>
      <button type="button" onClick={() => setProject('proj-2')}>
        switch
      </button>
      <Probe projectId={project} />
    </>
  );
}

describe('Files refresh keyed on diskSeq', () => {
  it('refetches the project listings and open files when diskSeq grows', async () => {
    const t = await setup(changes(1, { applied: applied(1) }));
    await t.push(changes(2, { applied: applied(2) }));
    expect(t.keys()).toEqual([queryKeys.projectFiles(PROJECT), ['projectFile', PROJECT]]);
  });

  it('refetches when diskSeq grows while applied is already at 100 entries (the list stays 100 long)', async () => {
    const t = await setup(changes(300, { applied: applied(100) }));
    await t.push(changes(303, { applied: applied(100) }));
    expect(t.keys()).toEqual([queryKeys.projectFiles(PROJECT), ['projectFile', PROJECT]]);
    t.spy.mockClear();
    await t.push(changes(304, { applied: applied(100) }));
    expect(t.keys()).toHaveLength(2);
  });

  it('refetches for an undo, which changes files without adding a batch', async () => {
    const t = await setup(changes(5, { applied: applied(3) }));
    await t.push(changes(6, { applied: applied(3) }));
    expect(t.keys()).toHaveLength(2);
  });

  it('refetches when a batch grows in place (more writes in the same Auto turn)', async () => {
    const t = await setup(changes(1, { applied: applied(1) }));
    await t.push(changes(2, { applied: applied(1) }));
    await t.push(changes(3, { applied: applied(1) }));
    expect(t.keys()).toHaveLength(4);
  });

  it('does not refetch when only pending changes', async () => {
    const t = await setup(changes(4, { applied: applied(2) }));
    await t.push(changes(4, { applied: applied(2), pending: pending(1) }));
    await t.push(changes(4, { applied: applied(2), pending: pending(2) }));
    await t.push(changes(4, { applied: applied(2), pending: null }));
    expect(t.spy).not.toHaveBeenCalled();
  });

  it('does not refetch when the applied list grows but diskSeq does not', async () => {
    const t = await setup(changes(4, { applied: applied(2) }));
    await t.push(changes(4, { applied: applied(3) }));
    expect(t.spy).not.toHaveBeenCalled();
  });

  it('does not refetch when diskSeq stays or goes down', async () => {
    const t = await setup(changes(4));
    await t.push(changes(4));
    await t.push(changes(2));
    expect(t.spy).not.toHaveBeenCalled();
  });

  it('does not refetch for a project-less chat or an unknown project', async () => {
    for (const projectId of [null, undefined]) {
      const t = await setup(changes(1), { projectId });
      await t.push(changes(2));
      expect(t.keys().filter((k) => k[0] === 'projectFiles' || k[0] === 'projectFile')).toEqual([]);
      cleanup();
    }
  });

  it('the first load of the changes is not a change', async () => {
    const view = renderWithProviders(<Probe projectId={PROJECT} />);
    const spy = vi.spyOn(view.queryClient, 'invalidateQueries');
    spy.mockClear();
    await act(async () => {
      view.queryClient.setQueryData(queryKeys.chatChanges(CHAT), changes(7, { applied: applied(7) }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes on mount (panel open) and when the project changes', () => {
    const view = renderWithProviders(<Switcher />);
    const spy = vi.spyOn(view.queryClient, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)).toEqual([
      queryKeys.projectFiles('proj-2'),
      ['projectFile', 'proj-2'],
    ]);
  });
});
