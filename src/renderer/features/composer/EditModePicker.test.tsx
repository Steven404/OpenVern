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

/** A promise and the function that settles it, for holding a request open while the test looks at the UI. */
function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const sendButton = () => screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
function typeAndEnter(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('send is blocked while the mode is unconfirmed', () => {
  it('blocks the button and Enter while the PATCH is unanswered, even though the server already took Auto', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    const real = api.updateChat.bind(api);
    const response = gate();
    vi.spyOn(api, 'updateChat').mockImplementation(async (id, patch) => {
      const summary = await real(id, patch); // the server commits now…
      await response.promise; // …and the answer is late
      return summary;
    });
    const sendMessage = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();
    await choose('auto');
    await waitFor(() => expect(chip().getAttribute('aria-busy')).toBe('true'));
    expect((chip() as HTMLButtonElement).disabled).toBe(true);
    expect(chip().getAttribute('data-mode')).toBe('review');
    expect((await api.getChat(chat.id)).editMode).toBe('auto');

    typeAndEnter('make the edits');
    await tick();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(true);
    fireEvent.submit(sendButton().closest('form') as HTMLFormElement);
    await tick();
    expect(sendMessage).not.toHaveBeenCalled();

    response.open();
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    expect(chip().getAttribute('aria-busy')).toBeNull();
    expect(sendButton().disabled).toBe(false);
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useRunsStore.getState().runs[chat.id]).toBeUndefined(), { timeout: 4000 });
  });

  it('a second choice while one is in flight is not sent', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    const real = api.updateChat.bind(api);
    const response = gate();
    const update = vi.spyOn(api, 'updateChat').mockImplementation(async (id, patch) => {
      await response.promise;
      return real(id, patch);
    });
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();
    await choose('auto');
    await waitFor(() => expect((chip() as HTMLButtonElement).disabled).toBe(true));
    // The menu can't open on a disabled chip; a pick that slips through anyway is dropped.
    fireEvent.keyDown(chip(), { key: 'Enter' });
    await tick();
    expect(screen.queryByTestId('edit-mode-review')).toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
    response.open();
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('after a failed PATCH, keeps send blocked until a fresh read confirms the mode the server kept', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    vi.spyOn(api, 'updateChat').mockRejectedValue(new ApiError(errorInfo('internal'), 500));
    const sendMessage = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();
    const real = api.getChat.bind(api);
    const read = gate();
    const getChat = vi.spyOn(api, 'getChat').mockImplementation(async (id) => {
      await read.promise;
      return real(id);
    });
    await choose('auto');
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't change the edit mode. Try again.");
    await waitFor(() => expect(getChat).toHaveBeenCalled());
    expect(chip().getAttribute('aria-busy')).toBe('true');
    typeAndEnter('make the edits');
    await tick();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(true);

    read.open();
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(chip().getAttribute('data-mode')).toBe('review');
    expect(chip().getAttribute('aria-busy')).toBeNull();
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useRunsStore.getState().runs[chat.id]).toBeUndefined(), { timeout: 4000 });
  });

  it('when that read fails too, says so, keeps send blocked, and "Try again" reads again', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    vi.spyOn(api, 'updateChat').mockRejectedValue(new ApiError(errorInfo('internal'), 500));
    const sendMessage = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();
    const getChat = vi.spyOn(api, 'getChat').mockRejectedValueOnce(new ApiError(errorInfo('network_error'), 0));
    await choose('auto');
    expect((await screen.findByRole('alert')).textContent).toContain(
      "Couldn't check this chat's edit mode, so sending is paused.",
    );
    typeAndEnter('make the edits');
    await tick();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(getChat).toHaveBeenCalledTimes(2);
    expect(chip().getAttribute('data-mode')).toBe('review');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('an older chat response never overwrites a confirmed mode', () => {
  it('a read that captured Review before the switch lands after it: the chat and the chat list stay Auto', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    const { queryClient } = renderWithProviders(<ReplyComposer chat={chat} />, { api });
    // The list has no observer here (no sidebar), so only an explicit cancel can stop its old read.
    queryClient.setQueryDefaults(queryKeys.chats, { queryFn: () => api.listChats() });
    queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, await api.listChats());
    await findChip();

    const old = gate();
    const snapshot = await api.getChat(chat.id); // Review, as the server has it now
    const listSnapshot = await api.listChats();
    vi.spyOn(api, 'getChat').mockImplementationOnce(async () => {
      await old.promise;
      return snapshot;
    });
    vi.spyOn(api, 'listChats').mockImplementationOnce(async () => {
      await old.promise;
      return listSnapshot;
    });
    void queryClient.refetchQueries({ queryKey: queryKeys.chat(chat.id) });
    void queryClient.refetchQueries({ queryKey: queryKeys.chats });
    await tick();

    await choose('auto');
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    old.open();
    await tick();
    await tick();
    expect(chip().getAttribute('data-mode')).toBe('auto');
    expect(queryClient.getQueryData<Chat>(queryKeys.chat(chat.id))?.editMode).toBe('auto');
    expect(queryClient.getQueryData<ChatSummary[]>(queryKeys.chats)?.find((c) => c.id === chat.id)?.editMode).toBe(
      'auto',
    );
  });

  it('a PATCH the server took but whose answer was lost: the check ignores an older read and finds Auto', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    const real = api.updateChat.bind(api);
    vi.spyOn(api, 'updateChat').mockImplementation(async (id, patch) => {
      await real(id, patch); // the server commits…
      throw new ApiError(errorInfo('network_error'), 0); // …and the answer never arrives
    });
    const sendMessage = vi.spyOn(api, 'sendMessage');
    const { queryClient } = renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();

    const old = gate();
    const snapshot = await api.getChat(chat.id); // Review, from before the switch
    vi.spyOn(api, 'getChat').mockImplementationOnce(async () => {
      await old.promise;
      return snapshot;
    });
    void queryClient.refetchQueries({ queryKey: queryKeys.chat(chat.id) });
    await tick();

    await choose('auto');
    // The check must not reuse the old read: it finds Auto while the old read is still unanswered.
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    old.open();
    await tick();
    await tick();
    expect(chip().getAttribute('data-mode')).toBe('auto');
    expect(queryClient.getQueryData<Chat>(queryKeys.chat(chat.id))?.editMode).toBe('auto');
    expect(sendButton().disabled).toBe(true); // no text yet
    typeAndEnter('go');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useRunsStore.getState().runs[chat.id]).toBeUndefined(), { timeout: 4000 });
  });

  it('a read that started while the PATCH was in flight lands after it: the cache stays Auto', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { git } = await projects(api);
    const chat = await chatIn(api, git.id);
    const { queryClient } = renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await findChip();

    const patch = gate();
    const real = api.updateChat.bind(api);
    vi.spyOn(api, 'updateChat').mockImplementation(async (id, body) => {
      await patch.promise; // the server hasn't taken Auto yet
      return real(id, body);
    });
    await choose('auto');
    await waitFor(() => expect(chip().getAttribute('aria-busy')).toBe('true'));

    const old = gate();
    const snapshot = await api.getChat(chat.id); // still Review
    vi.spyOn(api, 'getChat').mockImplementationOnce(async () => {
      await old.promise;
      return snapshot;
    });
    void queryClient.refetchQueries({ queryKey: queryKeys.chat(chat.id) });
    await tick();

    patch.open();
    await waitFor(() => expect(chip().getAttribute('data-mode')).toBe('auto'));
    old.open();
    await tick();
    await tick();
    expect(chip().getAttribute('data-mode')).toBe('auto');
    expect(queryClient.getQueryData<Chat>(queryKeys.chat(chat.id))?.editMode).toBe('auto');
  });
});
