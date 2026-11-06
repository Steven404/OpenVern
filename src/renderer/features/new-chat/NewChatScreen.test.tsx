import { DEFAULT_MODEL } from '@shared/constants';
import { SAMPLE_MODELS } from '@shared/sample-data';
import type { ModelInfo } from '@shared/types';
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

beforeAll(installDomStubs);
beforeEach(() => {
  resetStores();
  usePanelStore.setState({ chats: {} });
});
afterEach(cleanup);

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function Goto({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      go {to}
    </button>
  );
}

function ChatRoute() {
  const id = useLocation().pathname.split('/').at(-1) ?? '';
  return <Conversation chatId={id} />;
}

function App() {
  return (
    <>
      <Probe />
      <Routes>
        <Route path="/new" element={<NewChatScreen />} />
        <Route path="/chat/:id" element={<ChatRoute />} />
      </Routes>
    </>
  );
}

const textarea = () => screen.getByLabelText('Message') as HTMLTextAreaElement;
const chip = () => screen.getByRole('button', { name: /^Project:/ });

describe('NewChatScreen', () => {
  it('renders the hero, the new composer and the "No project" chip', async () => {
    renderWithProviders(<App />, { route: '/new' });
    expect(screen.getByRole('heading', { name: 'What are we building?' })).toBeTruthy();
    expect(textarea().placeholder).toBe('Ask a question, paste a snippet, or describe a task…');
    expect(textarea().rows).toBe(3);
    expect(chip().textContent).toBe('No project');
    expect(await screen.findByRole('button', { name: 'Model: Claude Sonnet 5.5' })).toBeTruthy();
    expect(screen.getByText('Enter to send · Shift + Enter for a new line')).toBeTruthy();
  });

  it('preselects the project from ?project=<id> and reacts to changes of it', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [a, b] = await api.listProjects();
    renderWithProviders(
      <>
        <Goto to={paths.newChat(b?.id)} />
        <App />
      </>,
      { api, route: paths.newChat(a?.id) },
    );
    await waitFor(() => expect(chip().textContent).toBe(a?.name));
    fireEvent.click(screen.getByRole('button', { name: `go ${paths.newChat(b?.id)}` }));
    await waitFor(() => expect(chip().textContent).toBe(b?.name));
  });

  it('falls back to "No project" for an unknown project id', async () => {
    renderWithProviders(<App />, { route: '/new?project=does-not-exist' });
    await waitFor(() => expect(chip().textContent).toBe('No project'));
  });

  it('chip menu lists "No project", every project and "Add project…"', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const projects = await api.listProjects();
    renderWithProviders(<App />, { api, route: '/new' });
    await screen.findByRole('button', { name: /^Model:/ });
    fireEvent.keyDown(chip(), { key: 'Enter' });
    await waitFor(() => expect(screen.getAllByRole('menuitemradio')).toHaveLength(projects.length + 1));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['No project', ...projects.map((p) => p.name)]);
    expect(screen.getByRole('menuitem', { name: 'Add project…' })).toBeTruthy();

    fireEvent.click(items[2] as HTMLElement);
    await waitFor(() => expect(chip().textContent).toBe(projects[1]?.name));
    expect(screen.getByTestId('location').textContent).toBe(paths.newChat(projects[1]?.id));

    fireEvent.keyDown(chip(), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add project…' }));
    expect(useUiStore.getState().newProjectOpen).toBe(true);
  });

  it('starts with lastModel, then DEFAULT_MODEL, then the first tools+vision model', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    await api.updateSettings({ lastModel: 'openai/gpt-5.5' });
    const { unmount } = renderWithProviders(<App />, { api, route: '/new' });
    expect(await screen.findByRole('button', { name: 'Model: GPT-5.5' })).toBeTruthy();
    unmount();

    const api2 = new MockApiClient({ delayMs: 0 });
    await api2.updateSettings({ lastModel: 'gone/model' }); // not in the live list
    renderWithProviders(<App />, { api: api2, route: '/new' });
    expect(await screen.findByRole('button', { name: 'Model: Claude Sonnet 5.5' })).toBeTruthy();
    expect(DEFAULT_MODEL).toBe('anthropic/claude-sonnet-5.5');
  });

  it('first send: creates the chat, navigates to it and streams the reply from the runs store', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const project = (await api.listProjects())[0];
    const create = vi.spyOn(api, 'createChat');
    const send = vi.spyOn(api, 'sendMessage');
    const { queryClient } = renderWithProviders(<App />, { api, route: paths.newChat(project?.id) });
    await screen.findByRole('button', { name: 'Model: Claude Sonnet 5.5' });
    await waitFor(() => expect(chip().textContent).toBe(project?.name));

    fireEvent.change(textarea(), { target: { value: 'Explain the loop' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/^\/chat\/.+/));
    expect(create).toHaveBeenCalledWith({ projectId: project?.id, model: DEFAULT_MODEL });
    const chatId = screen.getByTestId('location').textContent?.replace('/chat/', '') ?? '';
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(chatId);
    expect(send.mock.calls[0]?.[1]).toEqual({
      text: 'Explain the loop',
      attachmentIds: [],
      model: DEFAULT_MODEL,
      effort: null,
    });

    // the run was started in the store, so the conversation shows the user bubble and then the reply
    expect(await screen.findByText('Explain the loop')).toBeTruthy();
    await screen.findByText(/Add a step limit early/);
    await waitFor(() => expect(useRunsStore.getState().runs[chatId]).toBeUndefined());
    expect(screen.getAllByTestId('user-bubble')).toHaveLength(1);
    expect(screen.getAllByTestId('tool-row')).toHaveLength(1);
    // title arrives through chat_updated
    expect(queryClient.getQueryData<{ title: string }>(['chat', chatId])?.title).toBe('Explain the loop');
  });

  it('moves the panel state from the draft to the created chat', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const project = (await api.listProjects())[0];
    renderWithProviders(
      <>
        <Goto to="/new" />
        <App />
      </>,
      { api, route: paths.newChat(project?.id) },
    );
    await screen.findByRole('button', { name: 'Model: Claude Sonnet 5.5' });
    usePanelStore.getState().openFile('__draft__', 'README.md');
    fireEvent.change(textarea(), { target: { value: 'hi' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/^\/chat\/.+/));
    const chatId = screen.getByTestId('location').textContent?.replace('/chat/', '') ?? '';
    const { chats } = usePanelStore.getState();
    expect(chats.__draft__).toBeUndefined();
    expect(chats[chatId]?.tabs).toEqual([{ type: 'file', path: 'README.md' }]);

    fireEvent.click(screen.getByRole('button', { name: 'go /new' }));
    await screen.findByRole('heading', { name: 'What are we building?' });
    expect(usePanelStore.getState().chats.__draft__?.tabs ?? []).toEqual([]);
  });

  it('keeps the run going after leaving the screen and shows its progress on return', async () => {
    const api = new MockApiClient({ delayMs: 5 });
    const project = (await api.listProjects())[0];
    renderWithProviders(
      <>
        <Goto to="/elsewhere" />
        <App />
        <Routes>
          <Route path="/elsewhere" element={<p>elsewhere</p>} />
        </Routes>
      </>,
      { api, route: paths.newChat(project?.id) },
    );
    await screen.findByRole('button', { name: 'Model: Claude Sonnet 5.5' });
    fireEvent.change(textarea(), { target: { value: 'long running question' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/^\/chat\/.+/));
    const chatId = screen.getByTestId('location').textContent?.replace('/chat/', '') ?? '';

    fireEvent.click(screen.getByRole('button', { name: 'go /elsewhere' })); // leave: Conversation unmounts
    expect(await screen.findByText('elsewhere')).toBeTruthy();
    expect(useRunsStore.getState().runs[chatId]?.status).toBe('running');

    await waitFor(() => expect(useRunsStore.getState().runs[chatId]).toBeUndefined(), { timeout: 5000 });
    expect((await api.getChat(chatId)).messages.at(-1)).toMatchObject({ role: 'assistant', status: 'complete' });
  });

  it('restores the text and shows an error when the chat cannot be created', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    vi.spyOn(api, 'createChat').mockRejectedValueOnce(new Error('disk full'));
    renderWithProviders(<App />, { api, route: '/new' });
    await screen.findByRole('button', { name: /^Model:/ });
    fireEvent.change(textarea(), { target: { value: 'hello' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(await screen.findByText('disk full')).toBeTruthy();
    expect(textarea().value).toBe('hello');
    expect(screen.getByTestId('location').textContent).toBe('/new');
  });

  // ── F3: effort ──
  it('a new chat starts from lastEffort, and the first send carries it', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    await api.updateSettings({ lastEffort: 'high' });
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<App />, { api, route: '/new' });
    await screen.findByRole('button', { name: 'Effort: High' });

    fireEvent.change(textarea(), { target: { value: 'Explain effort' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[1]).toMatchObject({ effort: 'high' });
    const chatId = send.mock.calls[0]?.[0] ?? '';
    await waitFor(() => expect(useRunsStore.getState().runs[chatId]).toBeUndefined());
  });

  it('choosing an effort on a new chat changes the first send and is remembered as lastEffort', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const update = vi.spyOn(api, 'updateSettings');
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<App />, { api, route: '/new' });
    const trigger = await screen.findByRole('button', { name: 'Effort: Default' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Low' }));
    expect(update).toHaveBeenLastCalledWith({ lastEffort: 'low' });
    await screen.findByRole('button', { name: 'Effort: Low' });

    fireEvent.change(textarea(), { target: { value: 'Quick one' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[1]).toMatchObject({ effort: 'low' });
    const chatId = send.mock.calls[0]?.[0] ?? '';
    await waitFor(() => expect(useRunsStore.getState().runs[chatId]).toBeUndefined());
  });

  // ── F3 follow-up: a level the chosen model does not publish behaves as Default ──
  it('an effort the new-chat model does not list shows Default, leaves lastEffort alone, and shows it again on a model that lists it', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    await api.updateSettings({ lastEffort: 'high' });
    const lowMax: ModelInfo = {
      id: 'test/low-max',
      name: 'Test: Low and Max',
      contextLength: 1000,
      supportsTools: true,
      supportsImages: false,
      supportsReasoning: true,
      reasoningEfforts: ['low', 'max'],
      promptPricePerMTok: null,
      completionPricePerMTok: null,
    };
    vi.spyOn(api, 'listModels').mockResolvedValue([...SAMPLE_MODELS, lowMax]);
    const update = vi.spyOn(api, 'updateSettings');
    renderWithProviders(<App />, { api, route: '/new' });
    await screen.findByRole('button', { name: 'Effort: High' });

    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Low and Max/ }));
    expect(await screen.findByRole('button', { name: 'Effort: Default' })).toBeTruthy();
    expect(update.mock.calls.filter(([patch]) => 'lastEffort' in patch)).toEqual([]);
    expect((await api.getSettings()).lastEffort).toBe('high');

    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Claude Sonnet 5.5/ }));
    expect(await screen.findByRole('button', { name: 'Effort: High' })).toBeTruthy();
  });

  it('the first send on such a model carries no level, and the new chat is created without touching lastEffort', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    await api.updateSettings({ lastEffort: 'high' });
    const lowMax: ModelInfo = {
      id: 'test/low-max',
      name: 'Test: Low and Max',
      contextLength: 1000,
      supportsTools: true,
      supportsImages: false,
      supportsReasoning: true,
      reasoningEfforts: ['low', 'max'],
      promptPricePerMTok: null,
      completionPricePerMTok: null,
    };
    vi.spyOn(api, 'listModels').mockResolvedValue([...SAMPLE_MODELS, lowMax]);
    const update = vi.spyOn(api, 'updateSettings');
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<App />, { api, route: '/new' });
    await screen.findByRole('button', { name: 'Effort: High' });
    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Low and Max/ }));
    await screen.findByRole('button', { name: 'Effort: Default' });

    fireEvent.change(textarea(), { target: { value: 'No level here' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[1]).toMatchObject({ model: 'test/low-max' });
    expect(send.mock.calls[0]?.[1]).toHaveProperty('effort', null);
    const chatId = send.mock.calls[0]?.[0] ?? '';
    await waitFor(() => expect(useRunsStore.getState().runs[chatId]).toBeUndefined());
    expect(update.mock.calls.filter(([patch]) => 'lastEffort' in patch)).toEqual([]);
    expect((await api.getSettings()).lastEffort).toBe('high');
  });
});
