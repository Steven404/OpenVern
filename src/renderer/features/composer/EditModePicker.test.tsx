import { DEFAULT_MODEL } from '@shared/constants';
import { errorInfo } from '@shared/errors';
import type { Chat, ChatSummary, Id } from '@shared/types';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api-client';
import { MockApiClient } from '../../lib/mock-api-client';
import { queryKeys } from '../../lib/query-keys';
import { useRunsStore } from '../../stores/runs';
import { STORAGE_KEYS, useUiStore } from '../../stores/ui';
import { ReplyComposer } from './ReplyComposer';
import { installDomStubs, renderWithProviders, resetStores } from './test-utils';

const NO_TOOLS_MODEL = 'google/gemma-3-4b-it';

beforeAll(installDomStubs);
beforeEach(() => {
  resetStores();
  window.localStorage.clear();
  useUiStore.setState({ autoNoGitAcknowledged: {} });
});
afterEach(cleanup);

async function projects(api: MockApiClient) {
  const all = await api.listProjects();
  const git = all.find((p) => p.inGitRepo);
  const noGit = all.find((p) => !p.inGitRepo);
  if (!git || !noGit) throw new Error('seed needs a Git and a no-Git project');
  return { git, noGit, all };
}

async function chatIn(api: MockApiClient, projectId: Id | null, model = DEFAULT_MODEL): Promise<Chat> {
  return api.createChat({ projectId, model });
}

const chipEl = () => screen.queryByTestId('edit-mode-chip');
const chip = () => screen.getByTestId('edit-mode-chip');

async function findChip() {
  return screen.findByTestId('edit-mode-chip');
}

function openMenu() {
  const trigger = chip();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

async function choose(mode: 'review' | 'auto') {
  openMenu();
  fireEvent.click(await screen.findByTestId(`edit-mode-${mode}`));
}

async function settle() {
  // Let the models/projects/chat queries resolve before asserting that something is absent.
  await screen.findByLabelText('Message');
  await new Promise((r) => setTimeout(r, 20));
}

describe('edit mode chip visibility', () => {
  it('shows for a project chat with a tools model, reading Review by default', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    const el = await findChip();
    expect(el.getAttribute('data-mode')).toBe('review');
    expect(el.getAttribute('aria-label')).toBe('Edit mode: Review');
  });

  it('is hidden for a loose chat (no project)', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await chatIn(api, null);
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await settle();
    expect(chipEl()).toBeNull();
  });

  it('is hidden for a model without tools', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id, NO_TOOLS_MODEL);
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByTestId('no-tools-notice');
    await settle();
    expect(chipEl()).toBeNull();
  });

  it('is hidden without an API key', async () => {
    const api = new MockApiClient({ delayMs: 0, keyConfigured: false });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByTestId('no-key-notice');
    await settle();
    expect(chipEl()).toBeNull();
  });

  it('keeps a stored Auto while a no-tools model hides the chip, and shows it again with a tools model', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id, NO_TOOLS_MODEL);
    await api.updateChat(chat.id, { editMode: 'auto' });
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByTestId('no-tools-notice');
    await settle();
    expect(chipEl()).toBeNull();
    expect((await api.getChat(chat.id)).editMode).toBe('auto');

    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Claude Sonnet 5.5/ }));
    expect((await findChip()).getAttribute('data-mode')).toBe('auto');
  });
});

describe('choosing a mode in a chat', () => {
  it('lists Review and Auto with their descriptions, the current one checked', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    renderWithProviders(<ReplyComposer chat={await chatIn(api, git.id)} />, { api });
    await findChip();
    openMenu();
    const review = await screen.findByTestId('edit-mode-review');
    const auto = screen.getByTestId('edit-mode-auto');
    expect(review.getAttribute('aria-checked')).toBe('true');
    expect(auto.getAttribute('aria-checked')).toBe('false');
    expect(review.textContent).toContain("You approve each edit before it's written.");
    expect(auto.textContent).toContain('Edits are written as the model works. You can undo each turn.');
  });

  it('choosing Auto PATCHes the chat and updates the chat and chat-list caches', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    const update = vi.spyOn(api, 'updateChat');
    const { queryClient } = renderWithProviders(<ReplyComposer chat={chat} />, { api });
    queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, await api.listChats());
    await findChip();
    await choose('auto');
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(chat.id, { editMode: 'auto' });
    expect(queryClient.getQueryData<Chat>(queryKeys.chat(chat.id))?.editMode).toBe('auto');
    expect(queryClient.getQueryData<ChatSummary[]>(queryKeys.chats)?.find((c) => c.id === chat.id)?.editMode).toBe(
      'auto',
    );
    expect(chip().getAttribute('aria-label')).toBe('Edit mode: Auto');

    await choose('review');
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('review'));
    expect(update).toHaveBeenLastCalledWith(chat.id, { editMode: 'review' });
  });

  it('choosing the current mode sends nothing', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const update = vi.spyOn(api, 'updateChat');
    renderWithProviders(<ReplyComposer chat={await chatIn(api, git.id)} />, { api });
    await findChip();
    await choose('review');
    await new Promise((r) => setTimeout(r, 20));
    expect(update).not.toHaveBeenCalled();
  });

  it('shows the error and keeps the old mode when the PATCH fails', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    vi.spyOn(api, 'updateChat').mockRejectedValue(new ApiError(errorInfo('internal'), 500));
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();
    await choose('auto');
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't change the edit mode. Try again.");
    expect(chip().getAttribute('data-mode')).toBe('review');
    expect((await api.getChat(chat.id)).editMode).toBe('review');
  });

  it('shows "Applies from your next message." while a run is active, and not otherwise', async () => {
    const api = new MockApiClient({ delayMs: 8 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();
    openMenu();
    await screen.findByTestId('edit-mode-review');
    expect(screen.queryByText('Applies from your next message.')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('edit-mode-review'), { key: 'Escape' });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'go' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await screen.findByRole('button', { name: 'Stop' });
    openMenu();
    expect(await screen.findByText('Applies from your next message.')).toBeTruthy();
    // A change during the run is still allowed: it applies from the next turn.
    fireEvent.click(screen.getByTestId('edit-mode-auto'));
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    await waitFor(() => expect(useRunsStore.getState().runs[chat.id]).toBeUndefined(), { timeout: 4000 });
  });
});

describe('the no-Git dialog', () => {
  it('shows the first time Auto is chosen in a project outside Git, and writes nothing yet', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { noGit } = await projects(api);
    const chat = await chatIn(api, noGit.id);
    const update = vi.spyOn(api, 'updateChat');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();
    await choose('auto');
    const dialog = await screen.findByTestId('no-git-dialog');
    expect(within(dialog).getByText('Turn on Auto for a folder without Git?')).toBeTruthy();
    expect(dialog.textContent).toContain(`${noGit.name} isn't a Git repository`);
    expect(update).not.toHaveBeenCalled();
    expect(chip().getAttribute('data-mode')).toBe('review');
  });

  it('"Keep Review" changes nothing, records nothing, and the dialog shows again next time', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { noGit } = await projects(api);
    const chat = await chatIn(api, noGit.id);
    const update = vi.spyOn(api, 'updateChat');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();
    await choose('auto');
    fireEvent.click(await screen.findByTestId('no-git-keep-review'));
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    expect(update).not.toHaveBeenCalled();
    expect(chip().getAttribute('data-mode')).toBe('review');
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
    expect(window.localStorage.getItem(STORAGE_KEYS.autoNoGitAcknowledged)).toBeNull();

    await choose('auto');
    expect(await screen.findByTestId('no-git-dialog')).toBeTruthy();
  });

  it('Escape closes it like "Keep Review"', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { noGit } = await projects(api);
    const update = vi.spyOn(api, 'updateChat');
    renderWithProviders(<ReplyComposer chat={await chatIn(api, noGit.id)} />, { api });
    await findChip();
    await choose('auto');
    fireEvent.keyDown(await screen.findByTestId('no-git-dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    expect(update).not.toHaveBeenCalled();
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
  });

  it('"Turn on Auto" sets Auto and records the project', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { noGit } = await projects(api);
    const chat = await chatIn(api, noGit.id);
    const update = vi.spyOn(api, 'updateChat');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();
    await choose('auto');
    fireEvent.click(await screen.findByTestId('no-git-turn-on-auto'));
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    expect(update).toHaveBeenCalledWith(chat.id, { editMode: 'auto' });
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({ [noGit.id]: true });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.autoNoGitAcknowledged) ?? 'null')).toEqual([noGit.id]);
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });

  it('a second chat of an acknowledged project switches to Auto without the dialog', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { noGit } = await projects(api);
    const first = await chatIn(api, noGit.id);
    const second = await chatIn(api, noGit.id);
    renderWithProviders(<ReplyComposer chat={first} />, { api });
    await findChip();
    await choose('auto');
    fireEvent.click(await screen.findByTestId('no-git-turn-on-auto'));
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    cleanup();

    renderWithProviders(<ReplyComposer chat={second} />, { api });
    await findChip();
    await choose('auto');
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });

  it("an acknowledgment for another project doesn't skip this project's dialog", async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { noGit } = await projects(api);
    useUiStore.setState({ autoNoGitAcknowledged: { 'some-other-project': true } });
    renderWithProviders(<ReplyComposer chat={await chatIn(api, noGit.id)} />, { api });
    await findChip();
    await choose('auto');
    expect(await screen.findByTestId('no-git-dialog')).toBeTruthy();
  });

  it('never shows for a project inside Git', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    renderWithProviders(<ReplyComposer chat={await chatIn(api, git.id)} />, { api });
    await findChip();
    await choose('auto');
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
  });

  it('choosing Review in a no-Git project never asks', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { noGit } = await projects(api);
    const chat = await chatIn(api, noGit.id);
    await api.updateChat(chat.id, { editMode: 'auto' });
    renderWithProviders(<ReplyComposer chat={{ ...chat, editMode: 'auto' }} />, { api });
    await waitFor(() => expect(chipEl()?.getAttribute('data-mode')).toBe('auto'));
    await choose('review');
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('review'));
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
  });
});
