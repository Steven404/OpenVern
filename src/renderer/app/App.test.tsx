import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { location, renderApp, resetUi, seededClient } from './test-utils';

beforeEach(resetUi);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const seeded = seededClient;

const ctrl = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true });

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

describe('Ctrl+N', () => {
  it('opens New chat with the current chat’s project preselected', async () => {
    const { client, chat } = await seeded();
    renderApp({ client, route: `/chat/${chat.id}` });
    await screen.findByRole('region', { name: 'Conversation' });
    // The shortcut reads the project from the chats list: wait until it has loaded.
    await screen.findAllByRole('link', { name: chat.title });
    ctrl('n');
    await waitFor(() => expect(location()).toBe(`/new?project=${chat.projectId}`));
  });

  it('is ignored while a dialog is open', async () => {
    renderApp({ route: '/chat/does-not-exist' });
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByRole('dialog', { name: 'Settings' });
    ctrl('n');
    expect(location()).toBe('/chat/does-not-exist');
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

  it('Ctrl+B toggles the sidebar', async () => {
    renderApp();
    await screen.findByRole('complementary');
    ctrl('b');
    expect(screen.queryByRole('complementary')).toBeNull();
    ctrl('b');
    expect(screen.getByRole('complementary')).toBeTruthy();
  });
});
