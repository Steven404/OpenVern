import { renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { sampleProposal } from '@renderer/lib/mock-changes';
import { readPersistedUi, STORAGE_KEYS } from '@renderer/stores/ui';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanelStore } from './panel-store';

beforeEach(() => {
  resetUi();
  usePanelStore.setState({ chats: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const toggle = () => screen.getByRole('button', { name: 'Toggle right panel' });
const panel = () => screen.getByRole('complementary', { name: 'Right panel' });

async function renderChat(opts: { loose?: boolean } = {}) {
  const seed = await seededClient();
  const chat = opts.loose ? await seed.client.createChat({ projectId: null, model: 'm' }) : seed.chat;
  const view = renderApp({ client: seed.client, route: `/chat/${chat.id}` });
  await screen.findByRole('heading', { level: 1, name: chat.title });
  return { ...seed, ...view, chat };
}

const openPanel = () => fireEvent.click(toggle());
const ctrlBracket = () => fireEvent.keyDown(window, { key: ']', ctrlKey: true });

describe('right panel shell', () => {
  it('toggles from the header and Ctrl+], with aria state', async () => {
    await renderChat();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('aria-controls')).toBe('right-panel');
    openPanel();
    expect(panel()).toBeTruthy();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    ctrlBracket();
    expect(screen.queryByRole('complementary', { name: 'Right panel' })).toBeNull();
    ctrlBracket();
    expect(panel()).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('complementary', { name: 'Right panel' })).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it('persists the open state', async () => {
    await renderChat();
    openPanel();
    expect(window.localStorage.getItem(STORAGE_KEYS.rightPanelOpen)).toBe('1');
    expect(readPersistedUi().rightPanelOpen).toBe(true);
    ctrlBracket();
    expect(readPersistedUi().rightPanelOpen).toBe(false);
  });

  it('ignores Ctrl+] while a dialog is open', async () => {
    await renderChat();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    ctrlBracket();
    expect(screen.queryByRole('complementary', { name: 'Right panel' })).toBeNull();
    dialog.remove();
    ctrlBracket();
    expect(panel()).toBeTruthy();
  });

  it('opens on Files in a project chat', async () => {
    await renderChat();
    openPanel();
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
    expect(await within(panel()).findByRole('navigation', { name: 'Project files' })).toBeTruthy();
  });
});

describe('launcher rules', () => {
  it('Terminal is always disabled; Diff is disabled until the chat has edits', async () => {
    await renderChat();
    openPanel();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Open a panel' }));
    const terminal = within(panel()).getByRole('button', { name: /Terminal/ }) as HTMLButtonElement;
    const diff = within(panel()).getByRole('button', { name: /Diff/ }) as HTMLButtonElement;
    expect(terminal.disabled).toBe(true);
    expect(terminal.textContent).toContain('Not available yet');
    expect(diff.disabled).toBe(true);
    expect(diff.textContent).toContain('Available after the current chat has made edits');
    expect((within(panel()).getByRole('button', { name: /^Files/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Diff is enabled once the chat has pending edits, and opens as a closable tab', async () => {
    const { client, chat } = await renderChat();
    vi.spyOn(client, 'getChatChanges').mockResolvedValue({
      pending: { revision: 1, messageId: 'm1', files: sampleProposal(), totalAdd: 1, totalDel: 0 },
      applied: [],
    });
    cleanup();
    renderApp({ client, route: `/chat/${chat.id}` });
    await screen.findByRole('heading', { level: 1, name: chat.title });
    openPanel();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Open a panel' }));
    const diff = within(panel()).getByRole('button', { name: /Diff/ }) as HTMLButtonElement;
    await waitFor(() => expect(diff.disabled).toBe(false));
    fireEvent.click(diff);
    expect(within(panel()).getByRole('tab', { name: 'Diff', selected: true })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close Diff' }));
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
  });

  it('F opens Files from the launcher', async () => {
    await renderChat();
    openPanel();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Open a panel' }));
    fireEvent.keyDown(within(panel()).getByRole('heading', { name: 'Open a panel' }), { key: 'f' });
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
  });

  it('a chat without a project shows the launcher with Files disabled', async () => {
    await renderChat({ loose: true });
    openPanel();
    const files = within(panel()).getByRole('button', { name: /^Files/ }) as HTMLButtonElement;
    expect(files.disabled).toBe(true);
    expect(files.textContent).toContain('Only for chats in a project');
    expect(within(panel()).getByRole('heading', { name: 'Open a panel' })).toBeTruthy();
  });
});
