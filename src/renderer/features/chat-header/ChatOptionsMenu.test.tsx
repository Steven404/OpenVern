import { AppProviders, AppRoutes } from '@renderer/app/App';
import { openMenu, renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { ApiError } from '@renderer/lib/api-client';
import { MockApiClient } from '@renderer/lib/mock-api-client';
import { queryKeys } from '@renderer/lib/query-keys';
import { useEditModes } from '@renderer/stores/edit-modes';
import { createRun, useRunsStore } from '@renderer/stores/runs';
import { useUiStore } from '@renderer/stores/ui';
import { CHAT_PROJECT_CHANGED, EDIT_MODE_CHANGED, MOVE_WHILE_RUNNING, PROJECT_NOT_IN_GIT } from '@shared/api';
import { errorInfo } from '@shared/errors';
import type { Chat, EditMode, ProjectListItem } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  resetUi();
  useUiStore.setState({ autoNoGitAcknowledged: {} });
  useEditModes.setState({ entries: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The seed's newest chat, in `mode`, open in the app; plus a Git and a no-Git project other than its own. */
async function renderChat(mode: EditMode) {
  const seed = await seededClient();
  await seed.client.updateChat(seed.chat.id, { editMode: mode });
  const others = seed.projects.filter((p) => p.id !== seed.project.id);
  const git = others.find((p) => p.inGitRepo);
  const noGit = others.find((p) => !p.inGitRepo);
  if (!git || !noGit) throw new Error('seed needs another Git project and one without Git');
  const view = renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
  const header = (await screen.findByRole('heading', { level: 1, name: seed.chat.title })).closest('header');
  if (!header) throw new Error('missing header');
  const update = vi.spyOn(seed.client, 'updateChat');
  return { ...seed, ...view, header, git, noGit, update };
}

async function moveTo(header: HTMLElement, target: ProjectListItem) {
  openMenu(within(header).getByRole('button', { name: 'Chat options' }));
  const sub = await screen.findByRole('menuitem', { name: 'Move to project' });
  sub.focus();
  fireEvent.keyDown(sub, { key: 'ArrowRight' });
  fireEvent.click(await screen.findByRole('menuitemradio', { name: target.name }));
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('moving an Auto chat to a project without Git', () => {
  it('asks first, naming the project, and moves nothing yet', async () => {
    const { header, noGit, update, client, chat, project } = await renderChat('auto');
    await moveTo(header, noGit);
    const dialog = await screen.findByTestId('no-git-dialog');
    expect(dialog.getAttribute('data-reason')).toBe('move');
    expect(within(dialog).getByText('Move this Auto chat to a folder without Git?')).toBeTruthy();
    expect(dialog.textContent).toContain(`${noGit.name} isn't a Git repository`);
    // Undo reaches the last 20 Auto batches only while they are still in the chat's history.
    expect(dialog.textContent).toContain(
      "OpenVern can undo up to the last 20 sets of edits still in this chat's history, but there is no other history to go back to.",
    );
    expect(within(dialog).getByRole('button', { name: 'Switch to Review' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Keep Auto' })).toBeTruthy();
    await tick();
    expect(update).not.toHaveBeenCalled();
    expect((await client.getChat(chat.id)).projectId).toBe(project.id);
  });

  it('"Switch to Review" moves the chat and sets Review in one PATCH, and records nothing', async () => {
    const { header, noGit, update, client, chat, project } = await renderChat('auto');
    await moveTo(header, noGit);
    fireEvent.click(await screen.findByTestId('no-git-keep-review'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(chat.id, {
      projectId: noGit.id,
      editMode: 'review',
      expectedEditMode: 'auto',
      expectedProjectId: project.id,
    });
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    const stored = await client.getChat(chat.id);
    expect([stored.projectId, stored.editMode]).toEqual([noGit.id, 'review']);
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
  });

  it('"Keep Auto" records the project and moves the chat in Auto', async () => {
    const { header, noGit, update, client, chat, project } = await renderChat('auto');
    await moveTo(header, noGit);
    fireEvent.click(await screen.findByTestId('no-git-turn-on-auto'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(chat.id, {
      projectId: noGit.id,
      expectedEditMode: 'auto',
      expectedProjectId: project.id,
      expectedInGitRepo: false,
    });
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    const stored = await client.getChat(chat.id);
    expect([stored.projectId, stored.editMode]).toEqual([noGit.id, 'auto']);
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({ [noGit.id]: true });
  });

  it('Escape closes it and moves nothing', async () => {
    const { header, noGit, update, client, chat, project } = await renderChat('auto');
    await moveTo(header, noGit);
    fireEvent.keyDown(await screen.findByTestId('no-git-dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    await tick();
    expect(update).not.toHaveBeenCalled();
    const stored = await client.getChat(chat.id);
    expect([stored.projectId, stored.editMode]).toEqual([project.id, 'auto']);
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
  });

  it('an acknowledged project moves without asking', async () => {
    const { header, noGit, update, chat, project } = await renderChat('auto');
    useUiStore.setState({ autoNoGitAcknowledged: { [noGit.id]: true } });
    await moveTo(header, noGit);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        projectId: noGit.id,
        expectedEditMode: 'auto',
        expectedProjectId: project.id,
        expectedInGitRepo: false,
      }),
    );
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });
});

describe('moves that never ask', () => {
  it('a Review chat to a project without Git', async () => {
    const { header, noGit, update, chat, project } = await renderChat('review');
    await moveTo(header, noGit);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        projectId: noGit.id,
        expectedEditMode: 'review',
        expectedProjectId: project.id,
      }),
    );
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });

  it('an Auto chat to a project inside Git', async () => {
    const { header, git, update, chat, project } = await renderChat('auto');
    await moveTo(header, git);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        projectId: git.id,
        expectedEditMode: 'auto',
        expectedProjectId: project.id,
        expectedInGitRepo: true,
      }),
    );
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });
});

describe('a move never relies on a mode the server no longer has', () => {
  it('Move is disabled while an Auto change is unanswered; after the answer, a move to a folder without Git asks', async () => {
    const { header, noGit, client, chat, project } = await renderChat('review');
    useUiStore.setState({ autoNoGitAcknowledged: { [project.id]: true } }); // the chip doesn't ask for this one
    // `renderChat` already spies on `updateChat`, so the real one comes from the class.
    const real = MockApiClient.prototype.updateChat.bind(client);
    let answer: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const update = vi.spyOn(client, 'updateChat').mockImplementation(async (id, patch) => {
      const summary = await real(id, patch); // committed…
      if (patch.editMode !== undefined && patch.projectId === undefined) await late; // …a mode answer is late
      return summary;
    });
    const chip = await screen.findByTestId('edit-mode-chip');
    chip.focus();
    fireEvent.keyDown(chip, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('edit-mode-auto'));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        editMode: 'auto',
        expectedProjectId: project.id,
        expectedInGitRepo: project.inGitRepo,
      }),
    );
    expect((await client.getChat(chat.id)).editMode).toBe('auto');

    // The chip still shows Review (busy): Move can't decide from it, so it is disabled.
    openMenu(within(header).getByRole('button', { name: 'Chat options' }));
    const sub = await screen.findByRole('menuitem', { name: 'Move to project' });
    expect(sub.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(sub, { key: 'Escape' });
    await tick();
    expect(update).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.getByTestId('edit-mode-chip').getAttribute('data-mode')).toBe('auto'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await moveTo(header, noGit);
    expect(await screen.findByTestId('no-git-dialog')).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('decides from the shown mode, not the cache: a cache set to Auto under a Review chip asks nothing and expects Review', async () => {
    const { header, noGit, update, chat, queryClient, project } = await renderChat('review');
    await screen.findByTestId('edit-mode-chip');
    queryClient.setQueryData<Chat>(queryKeys.chat(chat.id), (old) => (old ? { ...old, editMode: 'auto' } : old));
    await moveTo(header, noGit);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        projectId: noGit.id,
        expectedEditMode: 'review',
        expectedProjectId: project.id,
      }),
    );
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });

  it('a move refused because another window changed the mode says why, moves nothing, and the chip catches up', async () => {
    const { header, noGit, client, chat, project, update } = await renderChat('review');
    await screen.findByTestId('edit-mode-chip');
    await MockApiClient.prototype.updateChat.call(client, chat.id, { editMode: 'auto' }); // not through this window
    await moveTo(header, noGit);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        projectId: noGit.id,
        expectedEditMode: 'review',
        expectedProjectId: project.id,
      }),
    );
    const dialog = await screen.findByTestId('move-error-dialog');
    expect(within(dialog).getByText("Couldn't move this chat")).toBeTruthy();
    expect(dialog.textContent).toContain(EDIT_MODE_CHANGED);
    expect((await client.getChat(chat.id)).projectId).toBe(project.id);
    await waitFor(() => expect(screen.getByTestId('edit-mode-chip').getAttribute('data-mode')).toBe('auto'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByTestId('move-error-dialog')).toBeNull());
    // Tried again with the chip showing Auto, the move asks first.
    await moveTo(header, noGit);
    expect(await screen.findByTestId('no-git-dialog')).toBeTruthy();
  });

  it('any other refused move says so too', async () => {
    const { header, git, client } = await renderChat('review');
    vi.spyOn(client, 'updateChat').mockRejectedValue(
      new ApiError(errorInfo('conflict', 'Apply or discard the proposed edits first.'), 409),
    );
    await moveTo(header, git);
    const dialog = await screen.findByTestId('move-error-dialog');
    expect(dialog.textContent).toContain('Apply or discard the proposed edits first.');
  });
});

describe('a chat’s project never changes while a reply runs', () => {
  afterEach(() => useRunsStore.setState({ runs: {} }));

  it('Move is disabled while the chat’s run is active, with a line saying why; it comes back when the run ends', async () => {
    const { header, chat, update } = await renderChat('review');
    useRunsStore.setState({ runs: { [chat.id]: createRun(1) } });
    openMenu(within(header).getByRole('button', { name: 'Chat options' }));
    const sub = await screen.findByRole('menuitem', { name: 'Move to project' });
    expect(sub.getAttribute('aria-disabled')).toBe('true');
    const hint = screen.getByText('Stop the reply to move or archive this chat.');
    expect(sub.getAttribute('aria-describedby')).toBe(hint.id);
    sub.focus();
    fireEvent.keyDown(sub, { key: 'ArrowRight' });
    await tick();
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    expect(update).not.toHaveBeenCalled();
    fireEvent.keyDown(sub, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    useRunsStore.setState({ runs: {} });
    openMenu(within(header).getByRole('button', { name: 'Chat options' }));
    const again = await screen.findByRole('menuitem', { name: 'Move to project' });
    expect(again.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByText('Stop the reply to move or archive this chat.')).toBeNull();
  });

  it('a move the server refuses because a reply runs elsewhere shows its message and reads the chat again', async () => {
    const { header, git, client, chat, queryClient } = await renderChat('review');
    vi.spyOn(client, 'updateChat').mockRejectedValue(new ApiError(errorInfo('conflict', MOVE_WHILE_RUNNING), 409));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await moveTo(header, git);
    const dialog = await screen.findByTestId('move-error-dialog');
    expect(dialog.textContent).toContain(MOVE_WHILE_RUNNING);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chat(chat.id) }));
  });
});

describe('a folder that left Git since the projects list was read', () => {
  it('moving an Auto chat there ("in Git" on screen) is refused, and the next try asks first', async () => {
    const { header, git, update, client, chat, project } = await renderChat('auto');
    await screen.findByTestId('edit-mode-chip');
    client.setProjectInGitRepo(git.id, false);
    await moveTo(header, git);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        projectId: git.id,
        expectedEditMode: 'auto',
        expectedProjectId: project.id,
        expectedInGitRepo: true,
      }),
    );
    const dialog = await screen.findByTestId('move-error-dialog');
    expect(dialog.textContent).toContain(PROJECT_NOT_IN_GIT);
    expect(await client.getChat(chat.id)).toMatchObject({ projectId: project.id, editMode: 'auto' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByTestId('move-error-dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('edit-mode-chip').getAttribute('aria-busy')).toBeNull());
    // The list was read again: the folder is outside Git now, so the move asks first.
    await moveTo(header, git);
    const warning = await screen.findByTestId('no-git-dialog');
    expect(warning.textContent).toContain(`${git.name} isn't a Git repository`);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

function GoBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      go back
    </button>
  );
}

describe('the move warning belongs to the chat it opened for', () => {
  it('Back to another Auto chat while the warning is open closes it, and never moves the other chat', async () => {
    const seed = await seededClient();
    const { client } = seed;
    const noGit = seed.projects.find((p) => !p.inGitRepo);
    const git = seed.projects.find((p) => p.inGitRepo);
    if (!noGit || !git) throw new Error('seed needs a Git and a no-Git project');
    const a = await client.createChat({ projectId: git.id, model: seed.chat.model, editMode: 'auto' });
    const b = await client.createChat({ projectId: git.id, model: seed.chat.model, editMode: 'auto' });
    await client.updateChat(a.id, { title: 'Chat A' });
    await client.updateChat(b.id, { title: 'Chat B' });
    const update = vi.spyOn(client, 'updateChat');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <AppProviders client={client} queryClient={queryClient}>
        <MemoryRouter initialEntries={[`/chat/${b.id}`, `/chat/${a.id}`]} initialIndex={1}>
          <AppRoutes />
          <GoBack />
        </MemoryRouter>
      </AppProviders>,
    );
    const headerOf = async (title: string) => {
      const header = (await screen.findByRole('heading', { level: 1, name: title, hidden: true })).closest('header');
      if (!header) throw new Error('missing header');
      return header;
    };
    const headerA = await headerOf('Chat A');
    await waitFor(() => expect(screen.getByTestId('edit-mode-chip').getAttribute('data-mode')).toBe('auto'));
    await moveTo(headerA, noGit);
    expect((await screen.findByTestId('no-git-dialog')).textContent).toContain(`${noGit.name} isn't a Git repository`);

    // History goes back to chat B (also Auto, also loaded) while A's warning is open.
    fireEvent.click(screen.getByRole('button', { name: 'go back', hidden: true }));
    await headerOf('Chat B');
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    await tick();
    expect(update).not.toHaveBeenCalled();
    expect(await client.getChat(b.id)).toMatchObject({ projectId: git.id, editMode: 'auto' });
    expect(await client.getChat(a.id)).toMatchObject({ projectId: git.id, editMode: 'auto' });
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
  });
});

describe('moving a chat whose Auto is not on screen', () => {
  /**
   * A loose chat stored in Auto with no API key set: neither the chip nor the composer's Auto notice shows. Or
   * (`no tools`) a chat in a project whose model can't use tools, so the chip is hidden there too.
   */
  async function hiddenChat(mode: EditMode, where: 'loose, no key' | 'no tools' = 'loose, no key') {
    const seed = await seededClient();
    const { client } = seed;
    const git = seed.projects.find((p) => p.inGitRepo && p.id !== seed.project.id);
    const noGit = seed.projects.find((p) => !p.inGitRepo);
    if (!git || !noGit) throw new Error('seed needs a Git and a no-Git project');
    const created =
      where === 'no tools'
        ? await client.createChat({ projectId: seed.project.id, model: 'google/gemma-3-4b-it' })
        : await client.createChat({ projectId: null, model: seed.chat.model });
    await client.updateChat(created.id, { title: 'Hidden chat', editMode: mode, expectedInGitRepo: true });
    if (where === 'loose, no key') await client.removeOpenRouterKey();
    const view = renderApp({ client, route: `/chat/${created.id}` });
    const header = (await screen.findByRole('heading', { level: 1, name: 'Hidden chat' })).closest('header');
    if (!header) throw new Error('missing header');
    await waitFor(() => expect(useEditModes.getState().entries[created.id]).toMatchObject({ mode, status: 'known' }));
    // The composer has what decides its chip (the key, the models), and the chip stays hidden.
    await waitFor(() => expect(view.queryClient.getQueryData(queryKeys.settings)).toBeDefined());
    await waitFor(() => expect(view.queryClient.getQueryState(queryKeys.models)?.status).not.toBe('pending'));
    await tick();
    expect(screen.queryByTestId('edit-mode-chip')).toBeNull();
    const update = vi.spyOn(client, 'updateChat');
    return { ...view, client, chat: created, header, git, noGit, update };
  }

  it.each(['loose, no key', 'no tools'] as const)(
    'into a Git project it asks first (%s), and moves nothing yet',
    async (where) => {
      const { header, git, update, client, chat } = await hiddenChat('auto', where);
      await moveTo(header, git);
      const dialog = await screen.findByTestId('no-git-dialog');
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(dialog.getAttribute('data-reason')).toBe('move-hidden');
      expect(within(dialog).getByText('Keep this chat in Auto?')).toBeTruthy();
      expect(dialog.textContent).toContain(`This chat is in Auto. After the move to ${git.name}`);
      expect(dialog.textContent).toContain(
        "OpenVern can undo up to the last 20 sets of edits still in this chat's history.",
      );
      expect(dialog.textContent).not.toContain('Git repository');
      await tick();
      expect(update).not.toHaveBeenCalled();
      expect((await client.getChat(chat.id)).projectId).toBe(chat.projectId);
    },
  );

  it('"Switch to Review" moves it and sets Review in one PATCH', async () => {
    const { header, git, update, client, chat } = await hiddenChat('auto');
    await moveTo(header, git);
    fireEvent.click(await screen.findByTestId('no-git-keep-review'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(chat.id, {
      projectId: git.id,
      editMode: 'review',
      expectedEditMode: 'auto',
      expectedProjectId: chat.projectId,
    });
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    expect(await client.getChat(chat.id)).toMatchObject({ projectId: git.id, editMode: 'review' });
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
  });

  it('"Keep Auto" moves it in Auto, carrying the Git status, and records no no-Git acknowledgment', async () => {
    const { header, git, update, client, chat } = await hiddenChat('auto');
    await moveTo(header, git);
    fireEvent.click(await screen.findByTestId('no-git-turn-on-auto'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(chat.id, {
      projectId: git.id,
      expectedEditMode: 'auto',
      expectedProjectId: chat.projectId,
      expectedInGitRepo: true,
    });
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    expect(await client.getChat(chat.id)).toMatchObject({ projectId: git.id, editMode: 'auto' });
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
  });

  it('into a project without Git, exactly one dialog asks, and it says the chat is in Auto', async () => {
    const { header, noGit, update, chat } = await hiddenChat('auto');
    await moveTo(header, noGit);
    const dialog = await screen.findByTestId('no-git-dialog');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(dialog.getAttribute('data-reason')).toBe('move');
    expect(dialog.textContent).toContain(`${noGit.name} isn't a Git repository. This chat is in Auto`);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Auto' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.any(String), {
        projectId: noGit.id,
        expectedEditMode: 'auto',
        expectedProjectId: chat.projectId,
        expectedInGitRepo: false,
      }),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({ [noGit.id]: true });
  });

  it('a Review chat moves without asking', async () => {
    const { header, git, update, chat } = await hiddenChat('review');
    await moveTo(header, git);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        projectId: git.id,
        expectedEditMode: 'review',
        expectedProjectId: chat.projectId,
      }),
    );
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });

  it('a hidden-Auto chat moved out to No project does not ask (it can write nowhere there)', async () => {
    const { header, update, chat } = await hiddenChat('auto', 'no tools');
    openMenu(within(header).getByRole('button', { name: 'Chat options' }));
    const sub = await screen.findByRole('menuitem', { name: 'Move to project' });
    sub.focus();
    fireEvent.keyDown(sub, { key: 'ArrowRight' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'No project' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        projectId: null,
        expectedEditMode: 'auto',
        expectedProjectId: chat.projectId,
      }),
    );
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });
});

describe('a move carries the project the menu showed', () => {
  it('moved by another window while the warning was open: confirming is refused and the chat stays there', async () => {
    const { header, noGit, git, update, client, chat, project } = await renderChat('auto');
    await moveTo(header, noGit);
    const dialog = await screen.findByTestId('no-git-dialog');
    // Another window moves the chat (not through this window's spy).
    await MockApiClient.prototype.updateChat.call(client, chat.id, {
      projectId: git.id,
      expectedEditMode: 'auto',
      expectedInGitRepo: true,
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Auto' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, {
        projectId: noGit.id,
        expectedEditMode: 'auto',
        expectedProjectId: project.id,
        expectedInGitRepo: false,
      }),
    );
    const error = await screen.findByTestId('move-error-dialog');
    expect(error.textContent).toContain(CHAT_PROJECT_CHANGED);
    expect(await client.getChat(chat.id)).toMatchObject({ projectId: git.id, editMode: 'auto' });
  });
});

describe('a move refetches the chat’s changes', () => {
  /** The seed's Auto chat, whose one auto batch is undoable in its project, open in the app. */
  async function renderAutoChat() {
    const seed = await seededClient();
    const chat = seed.chats.find((c) => c.title === 'Streaming replies over SSE');
    const git = seed.projects.find((p) => p.inGitRepo && p.id !== chat?.projectId);
    if (!chat || !git) throw new Error('seed needs the Auto chat and another Git project');
    const view = renderApp({ client: seed.client, route: `/chat/${chat.id}` });
    const header = (await screen.findByRole('heading', { level: 1, name: chat.title })).closest('header');
    if (!header) throw new Error('missing header');
    await waitFor(() => expect(screen.getByTestId('edit-mode-chip').getAttribute('data-mode')).toBe('auto'));
    expect((await screen.findByTestId('auto-edits-card')).getAttribute('data-undo')).toBe('undoable');
    const invalidate = vi.spyOn(view.queryClient, 'invalidateQueries');
    return { ...seed, ...view, chat, git, header, invalidate };
  }

  it('after a move, the Auto card stops offering Undo without a manual refetch', async () => {
    const { header, git, chat, invalidate } = await renderAutoChat();
    await moveTo(header, git);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chatChanges(chat.id) }));
    await waitFor(async () =>
      expect((await screen.findByTestId('auto-edits-card')).getAttribute('data-undo')).toBe('unavailable'),
    );
  });

  it('a refused move refetches them too', async () => {
    const { header, git, chat, client, invalidate } = await renderAutoChat();
    vi.spyOn(client, 'updateChat').mockRejectedValue(new ApiError(errorInfo('conflict', CHAT_PROJECT_CHANGED), 409));
    await moveTo(header, git);
    await screen.findByTestId('move-error-dialog');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chatChanges(chat.id) }));
  });
});
