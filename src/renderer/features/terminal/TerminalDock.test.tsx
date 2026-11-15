import { location, renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { queryKeys } from '@renderer/lib/query-keys';
import { TERMINAL } from '@shared/terminal';
import type { ChatSummary } from '@shared/types';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// xterm cannot draw in jsdom: the terminal and its fit addon are recording fakes (see `test-fakes.ts`).
vi.mock('@xterm/xterm', () => import('./test-fakes'));
vi.mock('@xterm/addon-fit', () => import('./test-fakes'));

import { useTerminalUiStore } from './terminal-store';
import { FakeTerminalBridge, installTerminalBridge, resetTerminalFakes, Terminal } from './test-fakes';

// The fake secret is the `sk-or-v1-abcdef1234` form the secret scanner's allowlist already covers.
const FAKE_KEY = 'sk-or-v1-abcdef1234';

let bridge: FakeTerminalBridge;

beforeEach(() => {
  resetUi();
  window.sessionStorage.clear();
  useTerminalUiStore.setState({ openDocks: {}, focusRequests: {} });
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
    await waitFor(() => expect(bridge.opens).toHaveLength(2));
    await waitFor(() => expect(Terminal.last().writes).toEqual(['hello from the shell\r\n']));
    expect(bridge.closes).toEqual([]);
  });

  it('End closes the session and removes the dock', async () => {
    const { chat } = await renderChat();
    await openDock();
    fireEvent.click(button('End terminal'));
    expect(bridge.closes).toEqual([chat.id]);
    expect(dock()).toBeNull();
    await waitFor(() => expect(bridge.hasSession(chat.id)).toBe(false));
  });

  it('the exit code and Restart show when the shell exits, and Restart starts a new session', async () => {
    const { chat } = await renderChat();
    await openDock();
    act(() => bridge.emitExit(chat.id, { state: 'exited', exitCode: 1, signal: null }));

    expect(await screen.findByText('Shell exited with code 1.')).toBeTruthy();
    fireEvent.click(button('Restart'));

    await waitFor(() => expect(bridge.opens).toHaveLength(2));
    expect(bridge.opens[1]).toMatchObject({ chatId: chat.id });
    await waitFor(() => expect(screen.queryByText('Shell exited with code 1.')).toBeNull());
    expect(Terminal.instances[0]?.disposed).toBe(true);
    expect(bridge.closes).toEqual([]);
    expect(button('End terminal')).toBeTruthy();
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

    await client.deleteChat(chat.id);
    await queryClient.invalidateQueries({ queryKey: queryKeys.chats });

    await waitFor(() => expect(bridge.closes).toEqual([chat.id]));
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
});
