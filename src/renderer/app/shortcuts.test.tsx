import { useTerminalUiStore } from '@renderer/features/terminal/terminal-store';
import {
  FakeTerminalBridge,
  installTerminalBridge,
  resetTerminalFakes,
  Terminal,
} from '@renderer/features/terminal/test-fakes';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { location, renderApp, resetUi, seededClient } from './test-utils';

// xterm cannot draw in jsdom: the terminal and its fit addon are recording fakes (see `test-fakes.ts`).
vi.mock('@xterm/xterm', () => import('@renderer/features/terminal/test-fakes'));
vi.mock('@xterm/addon-fit', () => import('@renderer/features/terminal/test-fakes'));

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

type Modifiers = Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>>;
const press = (key: string, init: Modifiers, target: Node | Window = window) =>
  fireEvent.keyDown(target, { key, ...init });
const backtick = (init: Modifiers = { ctrlKey: true }) => press('`', init);
const dock = () => screen.queryByRole('region', { name: 'Terminal' });
const sidebar = () => screen.queryByRole('complementary');
const composer = () => screen.getByLabelText('Message') as HTMLTextAreaElement;

/** A chat with the bridge installed, and the chats list loaded (the shortcuts read it). */
async function renderChat() {
  const seed = await seededClient();
  const view = renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
  await screen.findByRole('region', { name: 'Conversation' });
  await screen.findAllByRole('link', { name: seed.chat.title });
  return { ...seed, ...view };
}

/** Opens the dock with `Ctrl`+backtick and waits until the terminal has the focus. */
async function openDockWithFocus() {
  backtick();
  await screen.findByRole('region', { name: 'Terminal' });
  await waitFor(() => expect(document.activeElement).toBe(Terminal.last().textarea));
}

describe('Ctrl+backtick toggles the terminal dock', () => {
  it('opens the dock for the chat on screen, and hides it again', async () => {
    await renderChat();
    expect(dock()).toBeNull();
    backtick();
    expect(await screen.findByRole('region', { name: 'Terminal' })).toBeTruthy();
    backtick();
    expect(dock()).toBeNull();
  });

  it('hiding it with the shortcut gives the composer focus back', async () => {
    await renderChat();
    await openDockWithFocus();
    backtick();
    expect(dock()).toBeNull();
    expect(document.activeElement).toBe(composer());
  });

  it('is not Cmd+backtick, which cycles windows on macOS', async () => {
    await renderChat();
    press('`', { metaKey: true });
    expect(dock()).toBeNull();
  });

  it.each([
    { label: 'Ctrl+Shift+`', init: { ctrlKey: true, shiftKey: true } },
    { label: 'Ctrl+Alt+`', init: { ctrlKey: true, altKey: true } },
  ])('ignores $label', async ({ init }) => {
    await renderChat();
    backtick(init);
    expect(dock()).toBeNull();
  });

  it('is ignored while a dialog is open, and works again once it closes', async () => {
    await renderChat();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    backtick();
    expect(dock()).toBeNull();
    dialog.remove();
    backtick();
    expect(await screen.findByRole('region', { name: 'Terminal' })).toBeTruthy();
  });

  it('does nothing on the new-chat screen, which has no terminal', async () => {
    renderApp({ route: '/new' });
    await screen.findByRole('heading', { name: 'What are we building?' });
    backtick();
    expect(dock()).toBeNull();
    expect(location()).toBe('/new');
  });

  it('does nothing in the web build, and leaves the key alone', async () => {
    installTerminalBridge(null);
    await renderChat();
    const notPrevented = backtick();
    expect(notPrevented).toBe(true);
    expect(dock()).toBeNull();
  });
});

describe('while the terminal has focus, only Ctrl+backtick is handled', () => {
  it.each([
    { label: 'Ctrl+B', key: 'b', init: { ctrlKey: true } },
    { label: 'Cmd+B', key: 'b', init: { metaKey: true } },
  ])('$label reaches the shell and does not toggle the sidebar', async ({ key, init }) => {
    await renderChat();
    await openDockWithFocus();
    press(key, init, Terminal.last().textarea ?? window);
    expect(sidebar()).not.toBeNull();
  });

  it.each([
    { label: 'Ctrl+N', init: { ctrlKey: true } },
    { label: 'Cmd+N', init: { metaKey: true } },
  ])('$label reaches the shell and does not start a new chat', async ({ init }) => {
    const { chat } = await renderChat();
    await openDockWithFocus();
    press('n', init, Terminal.last().textarea ?? window);
    expect(location()).toBe(`/chat/${chat.id}`);
  });

  it('Ctrl+backtick still hides the dock from inside the terminal', async () => {
    await renderChat();
    await openDockWithFocus();
    backtick({ ctrlKey: true });
    expect(dock()).toBeNull();
  });
});

describe('outside the terminal, the global shortcuts still work', () => {
  it('Ctrl+B and Ctrl+N act while the composer has the focus, with the dock open', async () => {
    const { project } = await renderChat();
    await openDockWithFocus();
    act(() => composer().focus());

    press('b', { ctrlKey: true }, composer());
    expect(sidebar()).toBeNull();
    press('b', { ctrlKey: true }, composer());
    expect(sidebar()).not.toBeNull();

    press('n', { ctrlKey: true }, composer());
    await waitFor(() => expect(location()).toBe(`/new?project=${project.id}`));
  });
});
