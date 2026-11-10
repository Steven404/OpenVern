import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { location, renderApp, resetUi, seededClient } from './test-utils';

beforeEach(resetUi);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const seeded = seededClient;

/** The primary modifier, as Windows/Linux (`Ctrl`) and macOS (`Cmd`) send it. Every shortcut must accept both. */
const MODIFIERS: { label: string; init: Record<string, boolean> }[] = [
  { label: 'Ctrl', init: { ctrlKey: true } },
  { label: 'Cmd', init: { metaKey: true } },
];
const press = (key: string, init: Record<string, boolean>) => fireEvent.keyDown(window, { key, ...init });

/** Stubs a macOS or Linux navigator. Every field is set, so detection agrees with itself. */
function stubPlatform(platform: 'mac' | 'linux') {
  vi.stubGlobal(
    'navigator',
    platform === 'mac'
      ? { userAgentData: { platform: 'macOS' }, platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' }
      : {
          userAgentData: { platform: 'Linux' },
          platform: 'Linux x86_64',
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
        },
  );
}

describe('App shell and routing', () => {
  it('shows the sidebar and the New chat screen at #/new, with New chat marked current', async () => {
    renderApp({ route: '/new' });
    expect(await screen.findByRole('heading', { level: 1, name: /What are we building/ })).toBeTruthy();
    expect(screen.getByText('OpenVern')).toBeTruthy();
    expect(screen.getByRole('button', { name: /New chat/ }).getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('OpenVern');
  });

  it('redirects unknown routes to #/new', async () => {
    renderApp({ route: '/nope/nothing' });
    await waitFor(() => expect(location()).toBe('/new'));
    expect(await screen.findByRole('heading', { level: 1, name: /What are we building/ })).toBeTruthy();
  });

  it('renders the chat screen at #/chat/:id and sets the document title', async () => {
    const { client, chat } = await seeded();
    renderApp({ client, route: `/chat/${chat.id}` });
    expect(await screen.findByRole('region', { name: 'Conversation' })).toBeTruthy();
    expect(await screen.findByPlaceholderText('Reply to OpenVern…')).toBeTruthy();
    await waitFor(() => expect(document.title).toBe(`${chat.title} — OpenVern`));
    expect(screen.getByRole('heading', { level: 1, name: chat.title })).toBeTruthy();
  });

  it('shows a not-found state for an unknown chat', async () => {
    renderApp({ route: '/chat/does-not-exist' });
    expect(await screen.findByText(/doesn't exist/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat' }));
    await waitFor(() => expect(location()).toBe('/new'));
  });
});

describe('platform shortcut labels (AS-03)', () => {
  it('shows ⌘ N on the New chat button on macOS', async () => {
    stubPlatform('mac');
    renderApp({ route: '/new' });
    const newChat = await screen.findByRole('button', { name: /New chat/ });
    expect(within(newChat).getByText('⌘ N')).toBeTruthy();
    expect(newChat.textContent).not.toContain('Ctrl');
  });

  it('shows Ctrl N on the New chat button on Linux', async () => {
    stubPlatform('linux');
    renderApp({ route: '/new' });
    const newChat = await screen.findByRole('button', { name: /New chat/ });
    expect(within(newChat).getByText('Ctrl N')).toBeTruthy();
    expect(newChat.textContent).not.toContain('⌘');
  });
});

describe.each(MODIFIERS)('$label+N (New chat)', ({ init }) => {
  it('opens New chat with the current chat’s project preselected', async () => {
    const { client, chat } = await seeded();
    renderApp({ client, route: `/chat/${chat.id}` });
    await screen.findByRole('region', { name: 'Conversation' });
    // The shortcut reads the project from the chats list: wait until it has loaded.
    await screen.findAllByRole('link', { name: chat.title });
    press('n', init);
    await waitFor(() => expect(location()).toBe(`/new?project=${chat.projectId}`));
  });

  it('is ignored while a dialog is open', async () => {
    renderApp({ route: '/chat/does-not-exist' });
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByRole('dialog', { name: 'Settings' });
    press('n', init);
    expect(location()).toBe('/chat/does-not-exist');
  });

  it('is ignored while a menu is open, and works again once it closes', async () => {
    renderApp({ route: '/chat/does-not-exist' });
    await screen.findByText(/doesn't exist/);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    press('n', init);
    expect(location()).toBe('/chat/does-not-exist');
    menu.remove();
    press('n', init);
    await waitFor(() => expect(location()).toBe('/new'));
  });
});

describe('sidebar collapse (D2) and responsive (D19)', () => {
  it('collapses, shows an Open sidebar button, persists, and reopens', async () => {
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(window.localStorage.getItem('openvern.sidebarCollapsed')).toBe('1');
    const open = screen.getByRole('button', { name: 'Open sidebar' });
    await waitFor(() => expect(document.activeElement).toBe(open));
    fireEvent.click(open);
    expect(await screen.findByRole('complementary')).toBeTruthy();
    expect(window.localStorage.getItem('openvern.sidebarCollapsed')).toBe('0');
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Collapse sidebar'));
  });

  it.each(MODIFIERS)('$label+B toggles the sidebar', async ({ init }) => {
    renderApp();
    await screen.findByRole('complementary');
    press('b', init);
    expect(screen.queryByRole('complementary')).toBeNull();
    press('b', init);
    expect(screen.getByRole('complementary')).toBeTruthy();
  });
});
