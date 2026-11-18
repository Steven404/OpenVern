import { openMenu, renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { ApiError } from '@renderer/lib/api-client';
import { MockApiClient } from '@renderer/lib/mock-api-client';
import { useUiStore } from '@renderer/stores/ui';
import { EDIT_MODE_CHANGED } from '@shared/api';
import { errorInfo } from '@shared/errors';
import type { EditMode, ProjectListItem } from '@shared/types';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  resetUi();
  useUiStore.setState({ autoNoGitAcknowledged: {} });
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
    expect(within(dialog).getByRole('button', { name: 'Switch to Review' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Keep Auto' })).toBeTruthy();
    await tick();
    expect(update).not.toHaveBeenCalled();
    expect((await client.getChat(chat.id)).projectId).toBe(project.id);
  });

  it('"Switch to Review" moves the chat and sets Review in one PATCH, and records nothing', async () => {
    const { header, noGit, update, client, chat } = await renderChat('auto');
    await moveTo(header, noGit);
    fireEvent.click(await screen.findByTestId('no-git-keep-review'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(chat.id, { projectId: noGit.id, editMode: 'review', expectedEditMode: 'auto' });
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    const stored = await client.getChat(chat.id);
    expect([stored.projectId, stored.editMode]).toEqual([noGit.id, 'review']);
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
  });

  it('"Keep Auto" records the project and moves the chat in Auto', async () => {
    const { header, noGit, update, client, chat } = await renderChat('auto');
    await moveTo(header, noGit);
    fireEvent.click(await screen.findByTestId('no-git-turn-on-auto'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(chat.id, { projectId: noGit.id, expectedEditMode: 'auto' });
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
    const { header, noGit, update, chat } = await renderChat('auto');
    useUiStore.setState({ autoNoGitAcknowledged: { [noGit.id]: true } });
    await moveTo(header, noGit);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, { projectId: noGit.id, expectedEditMode: 'auto' }),
    );
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });
});

describe('moves that never ask', () => {
  it('a Review chat to a project without Git', async () => {
    const { header, noGit, update, chat } = await renderChat('review');
    await moveTo(header, noGit);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, { projectId: noGit.id, expectedEditMode: 'review' }),
    );
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });

  it('an Auto chat to a project inside Git', async () => {
    const { header, git, update, chat } = await renderChat('auto');
    await moveTo(header, git);
    await waitFor(() => expect(update).toHaveBeenCalledWith(chat.id, { projectId: git.id, expectedEditMode: 'auto' }));
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });
});

describe('a move never relies on a mode the server no longer has', () => {
  it('moving while an Auto change is committed but unanswered is refused, says why, and moves nothing', async () => {
    const { header, noGit, client, chat, project } = await renderChat('review');
    useUiStore.setState({ autoNoGitAcknowledged: { [project.id]: true } }); // the chip doesn't ask for this one
    // `renderChat` already spies on `updateChat`, so the real one comes from the class.
    const real = MockApiClient.prototype.updateChat.bind(client);
    let answer: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const update = vi.spyOn(client, 'updateChat').mockImplementation(async (id, patch) => {
      const summary = await real(id, patch); // committed (a refused move throws here)…
      if (patch.editMode !== undefined && patch.projectId === undefined) await late; // …a mode answer is late
      return summary;
    });
    const chip = await screen.findByTestId('edit-mode-chip');
    chip.focus();
    fireEvent.keyDown(chip, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('edit-mode-auto'));
    await waitFor(() => expect(update).toHaveBeenCalledWith(chat.id, { editMode: 'auto' }));
    expect((await client.getChat(chat.id)).editMode).toBe('auto');

    // The chip still shows Review, so the menu doesn't warn, but it says which mode it decided from.
    await moveTo(header, noGit);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(chat.id, { projectId: noGit.id, expectedEditMode: 'review' }),
    );
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
    const dialog = await screen.findByTestId('move-error-dialog');
    expect(within(dialog).getByText("Couldn't move this chat")).toBeTruthy();
    expect(dialog.textContent).toContain(EDIT_MODE_CHANGED);
    expect((await client.getChat(chat.id)).projectId).toBe(project.id);
    await waitFor(() => expect(screen.getByTestId('edit-mode-chip').getAttribute('data-mode')).toBe('auto'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByTestId('move-error-dialog')).toBeNull());
    answer();
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
