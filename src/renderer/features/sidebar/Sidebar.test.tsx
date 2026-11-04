import { location, openMenu, renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { MockApiClient } from '@renderer/lib/mock-api-client';
import { readPersistedUi, STORAGE_KEYS, useUiStore } from '@renderer/stores/ui';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(resetUi);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Scoped to the sidebar: the New chat screen's project chip ("Project: …") would otherwise match `^P`.
const projectButton = async (name: string) =>
  within(await screen.findByRole('complementary', { name: 'Sidebar' })).findByRole('button', {
    name: new RegExp(`^${name}`),
  });

describe('Sidebar projects (D5, D6)', () => {
  it('lists projects with their chat counts and starts collapsed', async () => {
    const { client, project, projects } = await seededClient();
    renderApp({ client });
    const row = await projectButton(project.name);
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.textContent).toContain('3'); // stefanos-ai-openvern has three chats in the seed
    expect(projects).toHaveLength(3);
    expect(screen.queryByRole('link', { name: 'Agent loop and tool calls' })).toBeNull();
  });

  it('expands and collapses a project, and persists the expansion', async () => {
    const { client, project, chats } = await seededClient();
    const { unmount } = renderApp({ client });
    const row = await projectButton(project.name);
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const projectChats = chats.filter((c) => c.projectId === project.id);
    for (const chat of projectChats) expect(screen.getByRole('link', { name: chat.title })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.expandedProjects) ?? '[]')).toEqual([project.id]);

    // "Reload": drop the in-memory state and re-read it from localStorage.
    unmount();
    useUiStore.setState({ expandedProjects: {} });
    useUiStore.setState(readPersistedUi());
    renderApp({ client });
    const again = await projectButton(project.name);
    expect(again.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(again);
    expect(again.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.expandedProjects) ?? '[]')).toEqual([]);
  });

  it('survives unavailable localStorage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => readPersistedUi()).not.toThrow();
    const { client, project } = await seededClient();
    renderApp({ client });
    const row = await projectButton(project.name);
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it("auto-expands the active chat's project and marks the chat as current", async () => {
    const { client, chat, project } = await seededClient();
    renderApp({ client, route: `/chat/${chat.id}` });
    const row = await projectButton(project.name);
    await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('true'));
    const links = await screen.findAllByRole('link', { name: chat.title });
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    const other = screen.getByRole('link', { name: 'Streaming replies over SSE' });
    expect(other.getAttribute('aria-current')).toBeNull();
    // Manual collapse sticks while the chat stays open.
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('navigates to the chat when its link is clicked', async () => {
    const { client, project, chats } = await seededClient();
    renderApp({ client });
    fireEvent.click(await projectButton(project.name));
    const target = chats[1];
    if (!target) throw new Error('seed missing');
    fireEvent.click(await screen.findByRole('link', { name: target.title }));
    await waitFor(() => expect(location()).toBe(`/chat/${target.id}`));
  });

  it('sorts a project’s chats newest first', async () => {
    const client = new MockApiClient({ delayMs: 0, seed: false });
    const project = await client.createProject({ rootPath: '/tmp/p', name: 'P' });
    const first = await client.createChat({ projectId: project.id, model: 'm' });
    await client.updateChat(first.id, { title: 'Older' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await client.createChat({ projectId: project.id, model: 'm' });
    await client.updateChat(second.id, { title: 'Newer' });
    renderApp({ client });
    fireEvent.click(await projectButton('P'));
    const titles = (await screen.findAllByRole('link')).map((a) => a.textContent);
    expect(titles).toEqual(['Newer', 'Older']);
  });
});

describe('CHATS section and empty states (S6.3, S6.5)', () => {
  it('lists loose chats under CHATS, newest first, and hides the section when empty', async () => {
    const client = new MockApiClient({ delayMs: 0 });
    const older = await client.createChat({ projectId: null, model: 'm' });
    await client.updateChat(older.id, { title: 'Loose older' });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await client.createChat({ projectId: null, model: 'm' });
    await client.updateChat(newer.id, { title: 'Loose newer' });
    renderApp({ client });
    const heading = await screen.findByRole('heading', { name: 'Chats' });
    const section = heading.closest('section');
    if (!section) throw new Error('missing section');
    expect(
      within(section)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Loose newer', 'Loose older']);
  });

  it('shows "No projects yet" and an Add project button that opens the New project modal', async () => {
    const client = new MockApiClient({ delayMs: 0, seed: false });
    renderApp({ client });
    expect(await screen.findByText('No projects yet')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Chats' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeTruthy();
  });

  it('the + button next to PROJECTS opens the New project modal and focus returns to it on close', async () => {
    renderApp();
    const plus = await screen.findByRole('button', { name: 'New project' });
    plus.focus();
    fireEvent.click(plus);
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(plus));
  });
});

describe('Archived chats group', () => {
  /** Loose chats created oldest first; the ones named in `archive` are archived afterwards. */
  async function looseClient(titles: string[], archive: string[]) {
    const client = new MockApiClient({ delayMs: 0, seed: false });
    const made: Record<string, string> = {};
    for (const title of titles) {
      const chat = await client.createChat({ projectId: null, model: 'm' });
      await client.updateChat(chat.id, { title });
      made[title] = chat.id;
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const title of archive) await client.updateChat(made[title] ?? '', { archived: true });
    return { client, ids: made };
  }
  const chatsSection = async () => {
    const section = (await screen.findByRole('heading', { name: 'Chats' })).closest('section');
    if (!section) throw new Error('missing section');
    return section;
  };
  const toggleIn = (section: HTMLElement) => within(section).queryByRole('button', { name: /^Archived/ });
  const linkTitles = (section: HTMLElement) =>
    within(section)
      .queryAllByRole('link')
      .map((a) => a.textContent);

  it('keeps archived loose chats out of Chats; a collapsed Archived toggle with the count expands newest first', async () => {
    const { client } = await looseClient(['Old archived', 'Active', 'New archived'], ['Old archived', 'New archived']);
    renderApp({ client });
    const section = await chatsSection();
    expect(linkTitles(section)).toEqual(['Active']);
    const toggle = toggleIn(section);
    if (!toggle) throw new Error('missing Archived toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Archived2');
    expect(screen.queryByRole('link', { name: 'Old archived' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New archived' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(linkTitles(section)).toEqual(['Active', 'New archived', 'Old archived']);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(linkTitles(section)).toEqual(['Active']);
  });

  it('keeps the Chats section with only the toggle when every loose chat is archived', async () => {
    const { client } = await looseClient(['One', 'Two'], ['One', 'Two']);
    renderApp({ client });
    const section = await chatsSection();
    expect(linkTitles(section)).toEqual([]);
    expect(within(section).getAllByRole('button')).toHaveLength(1);
    const toggle = toggleIn(section);
    expect(toggle?.textContent).toBe('Archived2');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows no toggle when nothing is archived', async () => {
    const { client } = await looseClient(['One', 'Two'], []);
    renderApp({ client });
    const section = await chatsSection();
    expect(linkTitles(section)).toEqual(['Two', 'One']);
    expect(toggleIn(section)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
  });

  it('leaves project rows unaffected by archived loose chats', async () => {
    const { client, project } = await seededClient();
    const loose = await client.createChat({ projectId: null, model: 'm' });
    await client.updateChat(loose.id, { title: 'Parked', archived: true });
    renderApp({ client });
    const row = await projectButton(project.name);
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.textContent).toContain('3');
    const section = await chatsSection();
    expect(toggleIn(section)?.textContent).toBe('Archived1');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'Streaming replies over SSE' })).toBeTruthy();
    expect(linkTitles(section)).toEqual([]);
  });

  it('opening an archived chat expands the group and marks its link as the current page', async () => {
    const { client, ids } = await looseClient(
      ['Active', 'Archived one', 'Archived two'],
      ['Archived one', 'Archived two'],
    );
    renderApp({ client, route: `/chat/${ids['Archived one']}` });
    const section = await chatsSection();
    await waitFor(() => expect(toggleIn(section)?.getAttribute('aria-expanded')).toBe('true'));
    const link = within(section).getByRole('link', { name: 'Archived one' });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(within(section).getByRole('link', { name: 'Archived two' }).getAttribute('aria-current')).toBeNull();
    expect(within(section).getByRole('link', { name: 'Active' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('Project row "…" menu (S6.4)', () => {
  it('New chat here opens #/new with the project preselected', async () => {
    const { client, project } = await seededClient();
    renderApp({ client });
    await projectButton(project.name);
    openMenu(screen.getByRole('button', { name: `Options for ${project.name}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New chat here' }));
    await waitFor(() => expect(location()).toBe(`/new?project=${project.id}`));
  });

  it('Rename calls renameProject and updates the row', async () => {
    const { client, project } = await seededClient();
    const rename = vi.spyOn(client, 'renameProject');
    renderApp({ client });
    await projectButton(project.name);
    openMenu(screen.getByRole('button', { name: `Options for ${project.name}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(input.value).toBe(project.name);
    fireEvent.change(input, { target: { value: 'Renamed project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith(project.id, 'Renamed project'));
    expect(await projectButton('Renamed project')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Remove asks for confirmation, then moves the chats to CHATS', async () => {
    const { client, project, chats } = await seededClient();
    const remove = vi.spyOn(client, 'deleteProject');
    renderApp({ client });
    await projectButton(project.name);
    openMenu(screen.getByRole('button', { name: `Options for ${project.name}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove project?' });
    expect(dialog.textContent).toContain(
      `Remove "${project.name}" from OpenVern? Its 3 chats move to Chats. Files on disk are not touched.`,
    );
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(project.id));
    const heading = await screen.findByRole('heading', { name: 'Chats' });
    const moved = chats.filter((c) => c.projectId === project.id);
    const section = heading.closest('section');
    for (const chat of moved)
      expect(within(section as HTMLElement).getByRole('link', { name: chat.title })).toBeTruthy();
    expect(screen.queryByRole('button', { name: new RegExp(`^${project.name}`) })).toBeNull();
  });
});

describe('New chat button (D3)', () => {
  it('navigates to #/new', async () => {
    const { client, chat } = await seededClient();
    renderApp({ client, route: `/chat/${chat.id}` });
    const button = await screen.findByRole('button', { name: /New chat/ });
    expect(button.getAttribute('aria-current')).toBeNull();
    // Wait for the chats list so the current chat's project can be preselected.
    await screen.findAllByRole('link', { name: chat.title });
    fireEvent.click(button);
    await waitFor(() => expect(location()).toBe(`/new?project=${chat.projectId}`));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /New chat/ }).getAttribute('aria-current')).toBe('page'),
    );
  });
});
