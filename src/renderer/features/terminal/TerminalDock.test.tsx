import { AppProviders, AppRoutes } from '@renderer/app/App';
import { location, renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { queryKeys } from '@renderer/lib/query-keys';
import { TERMINAL } from '@shared/terminal';
import type { ChatSummary } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_PASTE_TOO_LARGE, TERMINAL_SKIPPED_OUTPUT, terminalRegistry } from './registry';

// xterm cannot draw in jsdom: the terminal and its fit addon are recording fakes (see `test-fakes.ts`).
vi.mock('@xterm/xterm', () => import('./test-fakes'));
vi.mock('@xterm/addon-fit', () => import('./test-fakes'));

import { availableDockHeight, DRAFT_FOLDER_NOTICE, draftTerminalTarget } from './TerminalDock';
import { useTerminalUiStore } from './terminal-store';
import { FakeTerminalBridge, installTerminalBridge, resetTerminalFakes, Terminal } from './test-fakes';

// The fake secret is the `sk-or-v1-abcdef1234` form the secret scanner's allowlist already covers.
const FAKE_KEY = 'sk-or-v1-abcdef1234';

let bridge: FakeTerminalBridge;

beforeEach(() => {
  resetUi();
  window.sessionStorage.clear();
  useTerminalUiStore.setState({ openDocks: {}, focusRequests: {}, draftProjectId: undefined });
  terminalRegistry.disposeAll();
  resetTerminalFakes();
  bridge = new FakeTerminalBridge();
  installTerminalBridge(bridge);
});

afterEach(() => {
  cleanup();
  installTerminalBridge(null);
  vi.restoreAllMocks();
});

const dock = () => screen.queryByRole('region', { name: 'Terminal' });
const composer = () => screen.getByLabelText('Message') as HTMLTextAreaElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

/** Renders a project chat with its terminal bridge, and waits until the chat and its project have loaded. */
async function renderChat() {
  const seed = await seededClient();
  const view = renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
  await screen.findByRole('heading', { level: 1, name: seed.chat.title });
  return { ...seed, ...view };
}

/** The same chat under `StrictMode`, which mounts, unmounts and remounts every effect (the app's own mode). */
async function renderStrictChat() {
  const seed = await seededClient();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <StrictMode>
      <AppProviders client={seed.client} queryClient={queryClient}>
        <MemoryRouter initialEntries={[`/chat/${seed.chat.id}`]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>
    </StrictMode>,
  );
  await screen.findByRole('heading', { level: 1, name: seed.chat.title });
  return seed;
}

/** `Ctrl`+backtick, the shortcut that opens the dock. */
async function openDock() {
  fireEvent.keyDown(window, { key: '`', ctrlKey: true });
  await screen.findByRole('region', { name: 'Terminal' });
  await waitFor(() => expect(bridge.opens).toHaveLength(1));
  await waitFor(() => expect(Terminal.instances).toHaveLength(1));
}

/** Selects text in the terminal, as a mouse drag would. */
function select(text: string | null) {
  act(() => Terminal.last().select(text));
}

describe('terminal dock: opening and the header', () => {
  it('starts the shell in the project folder and names the shell and folder in the header', async () => {
    const { chat, project } = await renderChat();
    await openDock();
    expect(bridge.opens[0]).toMatchObject({ chatId: chat.id, cwd: project.rootPath });
    expect(await screen.findByText(`zsh · ${project.rootPath}`)).toBeTruthy();
  });

  it('lays out with a shrinkable basis and the dock floor, so a long draft cannot clip the prompt', async () => {
    useTerminalUiStore.getState().setDockHeight(TERMINAL.dockDefaultHeight);
    await renderChat();
    await openDock();
    const section = dock() as HTMLElement;
    expect(section.style.flex).toBe(`0 1 ${TERMINAL.dockDefaultHeight}px`);
    expect(section.style.minHeight).toBe(`${TERMINAL.dockMinHeight}px`);
    // `shrink-0` was the bug: the dock must yield to the composer, never overflow its own column.
    expect(section.className).not.toContain('shrink-0');
  });

  it('puts the cursor in the terminal when it opens', async () => {
    await renderChat();
    await openDock();
    await waitFor(() => expect(document.activeElement).toBe(Terminal.last().textarea));
  });

  it('the height handle moves with the arrow keys (Shift for bigger steps) and remembers the height', async () => {
    await renderChat();
    await openDock();
    const handle = screen.getByRole('separator', { name: 'Resize terminal' });
    const before = Number(handle.getAttribute('aria-valuenow'));
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(before + 16);
    expect(window.localStorage.getItem('openvern.terminal.dockHeight')).toBe(String(before + 16));
    fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true });
    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(Math.max(TERMINAL.dockMinHeight, before + 16 - 48));
  });
});

describe('terminal dock: Hide, End and the session', () => {
  it('Hide keeps the session running: no close, and showing the dock again brings back its output', async () => {
    const { chat } = await renderChat();
    await openDock();
    bridge.emitData(chat.id, 'hello from the shell\r\n', 1);

    fireEvent.click(button('Hide terminal'));
    expect(dock()).toBeNull();
    expect(bridge.closes).toEqual([]);
    expect(bridge.hasSession(chat.id)).toBe(true);
    expect(document.activeElement).toBe(composer());

    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    await waitFor(() => expect(bridge.opens).toHaveLength(1));
    await waitFor(() => expect(Terminal.last().writes).toEqual(['hello from the shell\r\n']));
    expect(bridge.closes).toEqual([]);
  });

  it('End closes the session and removes the dock', async () => {
    const { chat } = await renderChat();
    await openDock();
    const ended = Terminal.last();
    fireEvent.click(button('End terminal'));
    expect(ended.disposed).toBe(true);
    expect(bridge.closes).toEqual([chat.id]);
    expect(dock()).toBeNull();
    await waitFor(() => expect(bridge.hasSession(chat.id)).toBe(false));
  });

  it('the exit code and Restart show when the shell exits, and Restart replaces the shell and focuses it', async () => {
    const { chat } = await renderChat();
    await openDock();
    act(() => bridge.emitExit(chat.id, { state: 'exited', exitCode: 1, signal: null }));

    expect(await screen.findByText('Shell exited with code 1.')).toBeTruthy();
    fireEvent.click(button('Restart'));

    await waitFor(() => expect(bridge.opens).toHaveLength(2));
    expect(bridge.opens[1]).toMatchObject({ chatId: chat.id, restart: true });
    await waitFor(() => expect(screen.queryByText('Shell exited with code 1.')).toBeNull());
    expect(Terminal.instances[0]?.disposed).toBe(true);
    expect(bridge.closes).toEqual([]);
    expect(button('End terminal')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(Terminal.last().textarea));
  });

  it('hiding and reopening an exited chat attaches to it: the replay, exit line and Restart stay', async () => {
    const { chat } = await renderChat();
    await openDock();
    bridge.emitData(chat.id, 'the last words\r\n', 1);
    act(() => bridge.emitExit(chat.id, { state: 'exited', exitCode: 2, signal: null }));
    await screen.findByText('Shell exited with code 2.');

    fireEvent.click(button('Hide terminal'));
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    await waitFor(() => expect(bridge.opens).toHaveLength(1));
    // A plain open attaches to the exited session; only Restart may replace it.
    expect(bridge.opens[0]).toMatchObject({ chatId: chat.id });
    expect(bridge.opens[0]).not.toHaveProperty('restart', true);

    await waitFor(() => expect(Terminal.last().writes).toEqual(['the last words\r\n']));
    expect(await screen.findByText('Shell exited with code 2.')).toBeTruthy();
    expect(button('Restart')).toBeTruthy();
  });

  it('a failed open shows a readable message and a Retry that opens again', async () => {
    const seed = await seededClient();
    const open = bridge.open.bind(bridge);
    bridge.open = async () => {
      throw new Error(
        "Error invoking remote method 'openvern:terminal:open': Error: At most 8 terminals can run at once. End one to open another.",
      );
    };
    renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    await screen.findByRole('heading', { level: 1, name: seed.chat.title });
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    await screen.findByRole('region', { name: 'Terminal' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('At most 8 terminals can run at once. End one to open another.');
    expect(alert.textContent).not.toContain('Error invoking remote method');

    bridge.open = open;
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(bridge.opens).toHaveLength(1));
    expect(await screen.findByText(`zsh · ${seed.project.rootPath}`)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an exit by signal names the signal instead of a code', async () => {
    const { chat } = await renderChat();
    await openDock();
    act(() => bridge.emitExit(chat.id, { state: 'exited', exitCode: null, signal: 9 }));
    expect(await screen.findByText('Shell exited on signal 9.')).toBeTruthy();
  });
});

describe('terminal dock: Add selection to chat', () => {
  it('is disabled without a selection, and enabled with one', async () => {
    await renderChat();
    await openDock();
    expect(button('Add selection to chat').disabled).toBe(true);
    select('npm test');
    expect(button('Add selection to chat').disabled).toBe(false);
    select(null);
    expect(button('Add selection to chat').disabled).toBe(true);
  });

  it('inserts a fenced text block into the composer, with the secret redacted', async () => {
    await renderChat();
    await openDock();
    select(`export KEY=${FAKE_KEY}\nnpm test`);
    fireEvent.click(button('Add selection to chat'));

    expect(composer().value).toBe('```text\nexport KEY=«redacted:sk-or-v1-…»\nnpm test\n```');
    expect(composer().value).not.toContain('abcdef1234');
    expect(document.activeElement).toBe(composer());
    expect(button('Add selection to chat').disabled).toBe(true);
  });

  it('keeps what is already typed and puts the block after it', async () => {
    await renderChat();
    await openDock();
    fireEvent.change(composer(), { target: { value: 'Why does this fail?' } });
    select('npm test');
    fireEvent.click(button('Add selection to chat'));
    expect(composer().value).toBe('Why does this fail?\n\n```text\nnpm test\n```');
  });

  it('cuts a selection longer than selectionMaxChars and says so', async () => {
    await renderChat();
    await openDock();
    select('z'.repeat(TERMINAL.selectionMaxChars + 1000));
    fireEvent.click(button('Add selection to chat'));

    const value = composer().value;
    expect(value.split('z').length - 1).toBe(TERMINAL.selectionMaxChars);
    expect(value).toContain(`[The selection was cut at ${TERMINAL.selectionMaxChars} characters.]`);
  });
});

describe('terminal dock: chat lifecycle', () => {
  it('deleting the chat closes its terminal', async () => {
    const { client, chat, queryClient } = await renderChat();
    await openDock();

    const deleted = Terminal.last();
    await client.deleteChat(chat.id);
    await queryClient.invalidateQueries({ queryKey: queryKeys.chats });

    await waitFor(() => expect(bridge.closes).toEqual([chat.id]));
    await waitFor(() => expect(deleted.disposed).toBe(true));
    expect(dock()).toBeNull();
  });

  it('archiving the chat keeps its terminal running', async () => {
    const { client, chat, queryClient } = await renderChat();
    await openDock();

    await client.updateChat(chat.id, { archived: true });
    await queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    await waitFor(() =>
      expect(queryClient.getQueryData<ChatSummary[]>(queryKeys.chats)?.find((c) => c.id === chat.id)?.archived).toBe(
        true,
      ),
    );

    expect(bridge.closes).toEqual([]);
    expect(dock()).not.toBeNull();
    expect(bridge.hasSession(chat.id)).toBe(true);
    expect(location()).toBe(`/chat/${chat.id}`);
  });

  it('a list that is still loading does not close a shell for a chat it omits', async () => {
    const { client, chat, chats, queryClient } = await renderChat();
    await openDock();
    const other = chats.find((c) => c.id !== chat.id);
    if (!other) throw new Error('seed has only one chat');

    let release: (value: ChatSummary[]) => void = () => {};
    const hanging = new Promise<ChatSummary[]>((resolve) => {
      release = resolve;
    });
    vi.spyOn(client, 'listChats').mockReturnValue(hanging);
    void queryClient.refetchQueries({ queryKey: queryKeys.chats });
    await waitFor(() => expect(queryClient.isFetching({ queryKey: queryKeys.chats })).toBe(1));

    // A refetch that has only part of the list (or a stale answer) must not look like a deletion.
    act(() => queryClient.setQueryData(queryKeys.chats, [other]));
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.chats)).toEqual([other]));
    expect(bridge.closes).toEqual([]);

    release(chats);
    await waitFor(() => expect(queryClient.isFetching({ queryKey: queryKeys.chats })).toBe(0));
    expect(bridge.closes).toEqual([]);
  });
});

describe('terminal dock: chats and projects that are not there', () => {
  it("does not open a shell for a chat id that isn't in the loaded list", async () => {
    const seed = await seededClient();
    renderApp({ client: seed.client, route: '/chat/deleted-chat' });
    await screen.findByText("This chat doesn't exist or was deleted.");

    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    expect(await screen.findByRole('region', { name: 'Terminal' })).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("This chat doesn't exist or was deleted");
    expect(alert.textContent).toContain('no terminal to open');
    expect(bridge.opens).toEqual([]);
    expect(bridge.closes).toEqual([]);
  });

  it('a failed projects query shows a clear error with a way to retry', async () => {
    const seed = await seededClient();
    const listProjects = seed.client.listProjects.bind(seed.client);
    seed.client.listProjects = async () => {
      throw new Error('The project service is down.');
    };

    renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    await screen.findByRole('heading', { level: 1, name: seed.chat.title });
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    await screen.findByRole('region', { name: 'Terminal' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load the project folder.");
    expect(alert.textContent).toContain('The project service is down.');
    expect(bridge.opens).toEqual([]);

    seed.client.listProjects = listProjects;
    fireEvent.click(within(dock() as HTMLElement).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bridge.opens).toHaveLength(1));
    expect(bridge.opens[0]).toMatchObject({ chatId: seed.chat.id, cwd: seed.project.rootPath });
    expect(await screen.findByText(`zsh · ${seed.project.rootPath}`)).toBeTruthy();
  });
});

describe('terminal dock: the New Chat screen', () => {
  const chip = () => screen.getByRole('button', { name: /^Project:/ });
  async function renderNew(route: string, client?: Awaited<ReturnType<typeof seededClient>>['client']) {
    const view = renderApp({ ...(client ? { client } : {}), route });
    await screen.findByRole('heading', { name: 'What are we building?' });
    return view;
  }

  it('without a project, asks main for Documents and never sends a path', async () => {
    await renderNew('/new');
    await openDock();
    expect(bridge.opens[0]).toStrictEqual({
      chatId: '__draft__',
      cwd: null,
      defaultFolder: 'documents',
      cols: expect.any(Number),
      rows: expect.any(Number),
    });
    expect(await screen.findByText('zsh · /home/you/Documents')).toBeTruthy();
    expect(screen.queryByText(/doesn't exist/)).toBeNull();
  });

  it('with a project, starts in its folder without the Documents flag', async () => {
    const seed = await seededClient();
    await renderNew(`/new?project=${seed.project.id}`, seed.client);
    await waitFor(() => expect(chip().textContent).toBe(seed.project.name));
    await openDock();
    expect(bridge.opens[0]).toMatchObject({ chatId: '__draft__', cwd: seed.project.rootPath });
    expect(bridge.opens[0]).not.toHaveProperty('defaultFolder');
    expect(await screen.findByText(`zsh · ${seed.project.rootPath}`)).toBeTruthy();
  });

  it('waits for the projects list before opening a project shell', async () => {
    const seed = await seededClient();
    const listProjects = seed.client.listProjects.bind(seed.client);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    seed.client.listProjects = async () => {
      await gate;
      return listProjects();
    };
    await renderNew(`/new?project=${seed.project.id}`, seed.client);
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    await screen.findByRole('region', { name: 'Terminal' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(bridge.opens).toEqual([]);
    release();
    await waitFor(() => expect(bridge.opens).toHaveLength(1));
    expect(bridge.opens[0]).toMatchObject({ chatId: '__draft__', cwd: seed.project.rootPath });
  });

  it('a chip change keeps the shell in its folder, opens nothing new and says so', async () => {
    const seed = await seededClient();
    await renderNew(`/new?project=${seed.project.id}`, seed.client);
    await waitFor(() => expect(chip().textContent).toBe(seed.project.name));
    await openDock();
    await screen.findByText(`zsh · ${seed.project.rootPath}`);
    expect(screen.queryByText(DRAFT_FOLDER_NOTICE)).toBeNull();

    fireEvent.keyDown(chip(), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'No project' }));
    await waitFor(() => expect(chip().textContent).toBe('No project'));

    expect(await screen.findByText(DRAFT_FOLDER_NOTICE)).toBeTruthy();
    expect(screen.getByText(`zsh · ${seed.project.rootPath}`)).toBeTruthy();
    expect(bridge.opens.filter((o) => !o.restart)).toHaveLength(1);
    expect(bridge.closes).toEqual([]);
    expect(Terminal.instances).toHaveLength(1);

    fireEvent.keyDown(chip(), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: seed.project.name }));
    await waitFor(() => expect(screen.queryByText(DRAFT_FOLDER_NOTICE)).toBeNull());
  });

  it('sending the first message moves the open terminal into the chat with its output', async () => {
    await renderNew('/new');
    await openDock();
    act(() => bridge.emitData('__draft__', 'pre-chat-41\r\n'));
    const term = Terminal.last();
    fireEvent.change(composer(), { target: { value: 'hi' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(location()).toMatch(/^\/chat\/.+/));
    const chatId = location().replace('/chat/', '');
    expect(bridge.adopts).toEqual([{ from: '__draft__', to: chatId }]);
    await screen.findByText('zsh · /home/you/Documents');
    expect(useTerminalUiStore.getState().openDocks).toEqual({ [chatId]: true });
    // The same emulator, no new shell, and the chat's later output reaches it.
    expect(Terminal.instances).toHaveLength(1);
    expect(bridge.opens).toHaveLength(1);
    act(() => bridge.emitData(chatId, 'after'));
    expect(term.writes).toEqual(['pre-chat-41\r\n', 'after']);
  });
});

describe('draftTerminalTarget', () => {
  const projects = [{ id: 'p1', rootPath: '/work/p1' }];
  it('starts in Documents without a project', () => {
    expect(draftTerminalTarget(null, undefined, false)).toStrictEqual({
      state: 'ready',
      projectId: null,
      cwd: null,
      defaultFolder: 'documents',
    });
  });
  it("starts in a known project's folder", () => {
    expect(draftTerminalTarget('p1', projects, false)).toStrictEqual({
      state: 'ready',
      projectId: 'p1',
      cwd: '/work/p1',
    });
  });
  it('waits for the list, and for one refetch of a project the list lacks', () => {
    expect(draftTerminalTarget('p1', undefined, false)).toStrictEqual({ state: 'waiting' });
    expect(draftTerminalTarget('p2', projects, false)).toStrictEqual({ state: 'waiting' });
    expect(draftTerminalTarget('p2', projects, true)).toMatchObject({ state: 'ready', projectId: null, cwd: null });
  });
});

describe('a chat without a project', () => {
  it('still starts in home, without the Documents flag', async () => {
    const seed = await seededClient();
    const chat = await seed.client.createChat({ projectId: null, model: 'm' });
    renderApp({ client: seed.client, route: `/chat/${chat.id}` });
    await screen.findByRole('region', { name: 'Conversation' });
    await screen.findAllByRole('link', { name: chat.title });
    await openDock();
    expect(bridge.opens[0]).toMatchObject({ chatId: chat.id, cwd: null });
    expect(bridge.opens[0]).not.toHaveProperty('defaultFolder');
  });
});

describe('terminal dock: focus', () => {
  it('does not let a focus request linger and steal focus when switching chats', async () => {
    const { chat, chats } = await renderChat();
    await openDock();
    expect(document.activeElement).toBe(Terminal.last().textarea);

    const other = chats.find((c) => c.id !== chat.id);
    if (!other) throw new Error('seed has only one chat');
    fireEvent.click(screen.getAllByRole('link', { name: other.title })[0] as HTMLElement);
    await screen.findByRole('heading', { level: 1, name: other.title });
    composer().focus();

    fireEvent.click(screen.getAllByRole('link', { name: chat.title })[0] as HTMLElement);
    await screen.findByRole('heading', { level: 1, name: chat.title });
    await waitFor(() => expect(dock()).not.toBeNull());
    expect(document.activeElement).toBe(composer());
    expect(document.activeElement).not.toBe(Terminal.last().textarea);
  });

  it('opening the dock under StrictMode still focuses the terminal', async () => {
    await renderStrictChat();
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    await screen.findByRole('region', { name: 'Terminal' });
    await waitFor(() => expect(Terminal.instances.length).toBeGreaterThan(0));
    await waitFor(() => expect(document.activeElement).toBe(Terminal.last().textarea));
  });
});

describe('terminal dock: measured height limit', () => {
  /** A fake chat column: jsdom has no layout, so every box is given its height by hand. */
  function column(child: { height: number; flexGrow?: string; position?: string }[]): {
    parent: HTMLElement;
    dock: HTMLElement;
  } {
    const parent = document.createElement('div');
    Object.defineProperty(parent, 'clientHeight', { configurable: true, value: 720 });
    for (const spec of child) {
      const el = document.createElement('div');
      el.style.flexGrow = spec.flexGrow ?? '0';
      el.style.position = spec.position ?? 'static';
      el.getBoundingClientRect = () => ({ height: spec.height }) as DOMRect;
      parent.append(el);
    }
    const dock = document.createElement('section');
    parent.append(dock);
    return { parent, dock };
  }

  it('leaves the conversation its floor and ignores the flexible child and absolute buttons', () => {
    const { dock } = column([
      { height: 64 },
      { height: 300, flexGrow: '1' },
      { height: 276 },
      { height: 36, position: 'absolute' },
    ]);
    // 720 − header 64 − composer 276 − conversation floor 96.
    expect(availableDockHeight(dock)).toBe(284);
  });

  it('never goes below the dock floor', () => {
    const { dock } = column([{ height: 64 }, { height: 0, flexGrow: '1' }, { height: 700 }]);
    expect(availableDockHeight(dock)).toBe(TERMINAL.dockMinHeight);
  });

  it('is null when there is no layout to measure', () => {
    expect(availableDockHeight(null)).toBeNull();
    const parent = document.createElement('div');
    Object.defineProperty(parent, 'clientHeight', { configurable: true, value: 0 });
    const dock = document.createElement('section');
    parent.append(dock);
    expect(availableDockHeight(dock)).toBeNull();
  });
});

describe('terminal dock: module boundaries', () => {
  it('the barrel does not pull xterm in: the dock and the hook are loaded lazily', async () => {
    const barrel = await import('./index');
    expect('TerminalDock' in barrel).toBe(false);
    expect('useTerminal' in barrel).toBe(false);
  });
});

for (const resource of ['chats', 'projects'] as const) {
  it(`keeps the mounted terminal through a failed background ${resource} refetch`, async () => {
    const { client, queryClient } = await renderChat();
    await openDock();
    const term = Terminal.last();
    const method = resource === 'chats' ? 'listChats' : 'listProjects';
    vi.spyOn(client, method).mockRejectedValue(new Error('background offline'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: resource === 'chats' ? queryKeys.chats : queryKeys.projects });
    });
    expect(screen.getByTestId('terminal-screen').contains(term.element)).toBe(true);
    expect(Terminal.last()).toBe(term);
    expect(term.disposed).toBe(false);
    expect(within(dock() as HTMLElement).queryByRole('alert')).toBeNull();
  });
}

it('shows an oversized paste notice in the dock without sending or echoing the paste', async () => {
  await renderChat();
  await openDock();
  const term = Terminal.last();
  const before = [...term.writes];
  act(() => term.type(`\x1b[200~${'x'.repeat(TERMINAL.pendingInputMaxBytes)}\x1b[201~`));
  expect(within(dock() as HTMLElement).getByRole('status').textContent).toBe(TERMINAL_PASTE_TOO_LARGE);
  expect(bridge.writes).toEqual([]);
  expect(term.writes).toEqual(before);
  act(() => term.type('echo small\r'));
  expect(within(dock() as HTMLElement).queryByRole('status')).toBeNull();
});

it('shows recovery status during a flood and resumes the same mounted dock', async () => {
  const { chat } = await renderChat();
  await openDock();
  const term = Terminal.last();
  vi.spyOn(term, 'write').mockImplementationOnce(() => {
    throw new Error('overflow');
  });
  act(() => bridge.emitData(chat.id, 'recent output'));
  expect(within(dock() as HTMLElement).getByRole('status').textContent).toContain('Restoring recent output');
  await waitFor(() => expect(within(dock() as HTMLElement).queryByRole('status')).toBeNull());
  expect(term.writes.join('')).toContain(TERMINAL_SKIPPED_OUTPUT);
  expect(Terminal.last()).toBe(term);
  act(() => bridge.emitData(chat.id, 'after recovery'));
  expect(term.writes.at(-1)).toBe('after recovery');
});
