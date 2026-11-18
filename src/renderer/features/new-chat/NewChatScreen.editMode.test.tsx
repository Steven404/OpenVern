import { EDIT_MODE_CHANGED, PROJECT_NOT_IN_GIT } from '@shared/api';
import { DEFAULT_MODEL } from '@shared/constants';
import type { Chat } from '@shared/types';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockApiClient } from '../../lib/mock-api-client';
import { paths } from '../../lib/routes';
import { useRunsStore } from '../../stores/runs';
import { useUiStore } from '../../stores/ui';
import { installDomStubs, renderWithProviders, resetStores } from '../composer/test-utils';
import { Conversation } from '../conversation';
import { usePanelStore } from '../right-panel/panel-store';
import { NewChatScreen } from './NewChatScreen';

const NO_TOOLS_MODEL = 'google/gemma-3-4b-it';

beforeAll(installDomStubs);
beforeEach(() => {
  resetStores();
  window.localStorage.clear();
  useUiStore.setState({ autoNoGitAcknowledged: {} });
  usePanelStore.setState({ chats: {} });
  useRunsStore.setState({ modeRefusals: {} });
});
afterEach(cleanup);

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function Goto({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {label}
    </button>
  );
}

function GoBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      go back
    </button>
  );
}

function ChatRoute() {
  const id = useLocation().pathname.split('/').at(-1) ?? '';
  return <Conversation chatId={id} />;
}

function App({ extra }: { extra?: React.ReactNode }) {
  return (
    <>
      <Probe />
      {extra}
      <Routes>
        <Route path="/new" element={<NewChatScreen />} />
        <Route path="/chat/:id" element={<ChatRoute />} />
      </Routes>
    </>
  );
}

const textarea = () => screen.getByLabelText('Message') as HTMLTextAreaElement;
const projectChip = () => screen.getByRole('button', { name: /^Project:/ });
const modeChip = () => screen.getByTestId('edit-mode-chip');

async function projectsOf(api: MockApiClient) {
  const all = await api.listProjects();
  const git = all.filter((p) => p.inGitRepo);
  const noGit = all.find((p) => !p.inGitRepo);
  if (!git[0] || !git[1] || !noGit) throw new Error('seed needs two Git projects and one without');
  return { gitA: git[0], gitB: git[1], noGit };
}

async function pick(mode: 'review' | 'auto') {
  const trigger = modeChip();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByTestId(`edit-mode-${mode}`));
}

async function ready(projectName: string) {
  await screen.findByRole('button', { name: /^Model:/ });
  await waitFor(() => expect(projectChip().textContent).toBe(projectName));
  return screen.findByTestId('edit-mode-chip');
}

function sendText(text: string) {
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.keyDown(textarea(), { key: 'Enter' });
}

describe('New chat: the edit mode chip', () => {
  it('shows for a project with a tools model, at Review, and is hidden without a project', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA } = await projectsOf(api);
    renderWithProviders(<App />, { api, route: '/new' });
    await screen.findByRole('button', { name: /^Model:/ });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('edit-mode-chip')).toBeNull();
    cleanup();

    renderWithProviders(<App />, { api, route: paths.newChat(gitA.id) });
    expect((await ready(gitA.name)).getAttribute('data-mode')).toBe('review');
  });

  it('sends the chosen mode with createChat, and the created chat has it', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA } = await projectsOf(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(<App />, { api, route: paths.newChat(gitA.id) });
    await ready(gitA.name);
    await pick('auto');
    expect(modeChip().getAttribute('data-mode')).toBe('auto');
    sendText('make the edits');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/^\/chat\/.+/));
    expect(create).toHaveBeenCalledWith({
      projectId: gitA.id,
      model: DEFAULT_MODEL,
      editMode: 'auto',
      expectedInGitRepo: true,
    });
    const created = (await create.mock.results[0]?.value) as Chat;
    expect(created.editMode).toBe('auto');
    expect((await api.getChat(created.id)).editMode).toBe('auto');
  });

  it('sends Review when the chip is left alone', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA } = await projectsOf(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(<App />, { api, route: paths.newChat(gitA.id) });
    await ready(gitA.name);
    sendText('hello');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({ projectId: gitA.id, model: DEFAULT_MODEL, editMode: 'review' });
  });

  it('starts at Review on every open of the screen', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA } = await projectsOf(api);
    renderWithProviders(
      <App
        extra={
          <>
            <Goto to={paths.newChat(gitA.id)} label="open again" />
            <Goto to="/chat/none" label="leave" />
            <Goto to={paths.newChat(gitA.id)} label="back" />
          </>
        }
      />,
      { api, route: paths.newChat(gitA.id) },
    );
    await ready(gitA.name);
    await pick('auto');
    expect(modeChip().getAttribute('data-mode')).toBe('auto');

    // The same URL, opened again ("New chat here"): a new navigation.
    fireEvent.click(screen.getByRole('button', { name: 'open again' }));
    await waitFor(() => expect(modeChip().getAttribute('data-mode')).toBe('review'));

    await pick('auto');
    fireEvent.click(screen.getByRole('button', { name: 'leave' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/chat/none'));
    // Leaving and coming back (a chat in between) is an open too.
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(paths.newChat(gitA.id)));
    expect((await screen.findByTestId('edit-mode-chip')).getAttribute('data-mode')).toBe('review');
  });

  it('Back to an earlier New chat, where Auto was picked, shows Review and sends Review', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA, gitB } = await projectsOf(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(
      <App
        extra={
          <>
            <Goto to={paths.newChat(gitB.id)} label="open B" />
            <GoBack />
          </>
        }
      />,
      { api, route: paths.newChat(gitA.id) },
    );
    await ready(gitA.name);
    await pick('auto');
    expect(modeChip().getAttribute('data-mode')).toBe('auto');

    fireEvent.click(screen.getByRole('button', { name: 'open B' }));
    await waitFor(() => expect(projectChip().textContent).toBe(gitB.name));
    expect(modeChip().getAttribute('data-mode')).toBe('review');

    // History brings back the entry Auto was picked in: still a new open.
    fireEvent.click(screen.getByRole('button', { name: 'go back' }));
    await waitFor(() => expect(projectChip().textContent).toBe(gitA.name));
    expect(screen.getByTestId('location').textContent).toBe(paths.newChat(gitA.id));
    expect(modeChip().getAttribute('data-mode')).toBe('review');
    await new Promise((r) => setTimeout(r, 20));
    expect(modeChip().getAttribute('data-mode')).toBe('review');

    sendText('hello');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({ projectId: gitA.id, model: DEFAULT_MODEL, editMode: 'review' });
  });

  it('resets to Review when the project changes from the chip, and the send then carries Review', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA, gitB } = await projectsOf(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(<App />, { api, route: paths.newChat(gitA.id) });
    await ready(gitA.name);
    await pick('auto');

    fireEvent.keyDown(projectChip(), { key: 'Enter' });
    const items = await screen.findAllByRole('menuitemradio');
    fireEvent.click(items.find((i) => i.textContent === gitB.name) as HTMLElement);
    await waitFor(() => expect(projectChip().textContent).toBe(gitB.name));
    await waitFor(() => expect(modeChip().getAttribute('data-mode')).toBe('review'));

    sendText('hello');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({ projectId: gitB.id, model: DEFAULT_MODEL, editMode: 'review' });
  });

  it('sends Review when a model without tools hides the chip, and the pick returns with a tools model', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA } = await projectsOf(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(<App />, { api, route: paths.newChat(gitA.id) });
    await ready(gitA.name);
    await pick('auto');

    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Gemma 3 4B/ }));
    await waitFor(() => expect(screen.queryByTestId('edit-mode-chip')).toBeNull());
    sendText('hello');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({ projectId: gitA.id, model: NO_TOOLS_MODEL, editMode: 'review' });
  });
});

describe('New chat: the mode on screen is the mode sent', () => {
  it('the first send expects the mode the chip showed, even when createChat answers otherwise, and is refused', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA } = await projectsOf(api);
    const realCreate = api.createChat.bind(api);
    // A server that ignored the pick: the chat is created in Review.
    vi.spyOn(api, 'createChat').mockImplementation((input) => realCreate({ ...input, editMode: 'review' }));
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<App />, { api, route: paths.newChat(gitA.id) });
    await ready(gitA.name);
    await pick('auto');
    sendText('make the edits');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[1]).toMatchObject({ text: 'make the edits', expectedEditMode: 'auto' });
    const chatId = screen.getByTestId('location').textContent?.split('/').at(-1) ?? '';
    await waitFor(() => expect(useRunsStore.getState().modeRefusals[chatId]?.message).toBe(EDIT_MODE_CHANGED));
    expect((await api.getChat(chatId)).messages).toEqual([]);
  });

  it('the chip shows while the model list is still loading, and createChat gets the mode it shows', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA } = await projectsOf(api);
    const models = gate();
    const realModels = api.listModels.bind(api);
    vi.spyOn(api, 'listModels').mockImplementation(async () => {
      await models.promise;
      return realModels();
    });
    const create = vi.spyOn(api, 'createChat');
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<App />, { api, route: paths.newChat(gitA.id) });
    await waitFor(() => expect(projectChip().textContent).toBe(gitA.name));
    await screen.findByTestId('edit-mode-chip');
    await pick('auto');
    expect(modeChip().getAttribute('data-mode')).toBe('auto');
    sendText('make the edits');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]).toMatchObject({ projectId: gitA.id, editMode: 'auto' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[1]).toMatchObject({ expectedEditMode: 'auto' });
    models.open();
  });
});

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('New chat: the no-Git warning', () => {
  it('"Turn on Auto" sets Auto for the new chat and records the project; the next open does not ask again', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { noGit } = await projectsOf(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(<App extra={<Goto to={paths.newChat(noGit.id)} label="open again" />} />, {
      api,
      route: paths.newChat(noGit.id),
    });
    await ready(noGit.name);
    await pick('auto');
    expect(await screen.findByTestId('no-git-dialog')).toBeTruthy();
    expect(modeChip().getAttribute('data-mode')).toBe('review');
    fireEvent.click(screen.getByTestId('no-git-turn-on-auto'));
    await waitFor(() => expect(modeChip().getAttribute('data-mode')).toBe('auto'));
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({ [noGit.id]: true });

    // A new open starts at Review, and choosing Auto again goes straight through.
    fireEvent.click(screen.getByRole('button', { name: 'open again' }));
    await waitFor(() => expect(modeChip().getAttribute('data-mode')).toBe('review'));
    await pick('auto');
    await waitFor(() => expect(modeChip().getAttribute('data-mode')).toBe('auto'));
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();

    sendText('go');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      projectId: noGit.id,
      model: DEFAULT_MODEL,
      editMode: 'auto',
      expectedInGitRepo: false,
    });
  });

  it('"Keep Review" creates the chat in Review', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { noGit } = await projectsOf(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(<App />, { api, route: paths.newChat(noGit.id) });
    await ready(noGit.name);
    await pick('auto');
    fireEvent.click(await screen.findByTestId('no-git-keep-review'));
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    expect(modeChip().getAttribute('data-mode')).toBe('review');
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});
    sendText('go');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({ projectId: noGit.id, model: DEFAULT_MODEL, editMode: 'review' });
  });
});

describe('New chat: a warning belongs to the project and opening it was shown for', () => {
  /** Two projects outside Git, neither acknowledged. */
  async function twoNoGit(api: MockApiClient) {
    const { noGit: a } = await projectsOf(api);
    const created = await api.createProject({ rootPath: '/home/you/no-git-b', name: 'Second folder' });
    api.setProjectInGitRepo(created.id, false);
    const b = (await api.listProjects()).find((p) => p.id === created.id);
    if (!b) throw new Error('missing project');
    return { a, b };
  }

  it("Back to an earlier New chat for project B while A's warning is open: the warning closes, B stays in Review and asks for itself", async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { a, b } = await twoNoGit(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(
      <App
        extra={
          <>
            <Goto to={paths.newChat(a.id)} label="open A" />
            <GoBack />
          </>
        }
      />,
      { api, route: paths.newChat(b.id) },
    );
    await ready(b.name);
    fireEvent.click(screen.getByRole('button', { name: 'open A' }));
    await ready(a.name);
    await pick('auto');
    const dialog = await screen.findByTestId('no-git-dialog');
    expect(dialog.textContent).toContain(`${a.name} isn't a Git repository`);

    // History goes back to the New chat for B while A's warning is open (the browser's Back, outside the modal).
    fireEvent.click(screen.getByRole('button', { name: 'go back', hidden: true }));
    await waitFor(() => expect(projectChip().textContent).toBe(b.name));
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    expect(modeChip().getAttribute('data-mode')).toBe('review');
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({});

    // Turning Auto on for B shows B's own warning.
    await pick('auto');
    const own = await screen.findByTestId('no-git-dialog');
    expect(own.textContent).toContain(`${b.name} isn't a Git repository`);
    fireEvent.click(screen.getByTestId('no-git-keep-review'));
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());

    sendText('hello');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({ projectId: b.id, model: DEFAULT_MODEL, editMode: 'review' });
    expect(create.mock.calls.some(([input]) => input.editMode === 'auto')).toBe(false);
  });

  it('a pick decided for one project never shows or sends Auto for another', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { a, b } = await twoNoGit(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(<App />, { api, route: paths.newChat(a.id) });
    await ready(a.name);
    await pick('auto');
    fireEvent.click(await screen.findByTestId('no-git-turn-on-auto'));
    await waitFor(() => expect(modeChip().getAttribute('data-mode')).toBe('auto'));
    // A change of project from the chip, then Auto for B: B's warning, not A's acknowledgment.
    fireEvent.keyDown(projectChip(), { key: 'Enter' });
    const items = await screen.findAllByRole('menuitemradio');
    fireEvent.click(items.find((i) => i.textContent === b.name) as HTMLElement);
    await waitFor(() => expect(projectChip().textContent).toBe(b.name));
    expect(modeChip().getAttribute('data-mode')).toBe('review');
    await pick('auto');
    expect((await screen.findByTestId('no-git-dialog')).textContent).toContain(`${b.name} isn't a Git repository`);
    fireEvent.keyDown(screen.getByTestId('no-git-dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('no-git-dialog')).toBeNull());
    sendText('hello');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({ projectId: b.id, model: DEFAULT_MODEL, editMode: 'review' });
  });
});

describe('New chat: a folder that left Git since the list was read', () => {
  it('createChat in Auto is refused, the chip drops to Review, and Auto again shows the warning', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const { gitA } = await projectsOf(api);
    const create = vi.spyOn(api, 'createChat');
    renderWithProviders(<App />, { api, route: paths.newChat(gitA.id) });
    await ready(gitA.name);
    await pick('auto');
    expect(screen.queryByTestId('no-git-dialog')).toBeNull();
    expect(modeChip().getAttribute('data-mode')).toBe('auto');
    // The folder loses its repository; the screen still has the old list.
    api.setProjectInGitRepo(gitA.id, false);
    sendText('make the edits');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ editMode: 'auto', expectedInGitRepo: true });
    expect(await screen.findByText(PROJECT_NOT_IN_GIT)).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe(paths.newChat(gitA.id));
    expect((await api.listChats()).some((c) => c.editMode === 'auto' && c.projectId === gitA.id)).toBe(false);
    expect(textarea().value).toBe('make the edits');
    // The list is read again: the pick no longer holds, and Auto asks first.
    await waitFor(() => expect(modeChip().getAttribute('data-mode')).toBe('review'));
    await pick('auto');
    expect((await screen.findByTestId('no-git-dialog')).textContent).toContain(`${gitA.name} isn't a Git repository`);
    fireEvent.click(screen.getByTestId('no-git-turn-on-auto'));
    await waitFor(() => expect(modeChip().getAttribute('data-mode')).toBe('auto'));
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[0]).toMatchObject({ editMode: 'auto', expectedInGitRepo: false });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/^\/chat\/.+/));
  });
});
