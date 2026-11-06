import { location, openMenu, renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { createRun, useRunsStore } from '@renderer/stores/runs';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(resetUi);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderChat() {
  const seed = await seededClient();
  const view = renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
  const header = (await screen.findByRole('heading', { level: 1, name: seed.chat.title })).closest('header');
  if (!header) throw new Error('missing header');
  return { ...seed, ...view, header };
}

const optionsButton = (header: HTMLElement) => within(header).getByRole('button', { name: 'Chat options' });
/** A project crumb splits its name and suffix into spans, so match the crumb (a header child) by its whole text. */
const crumbMatcher = (header: HTMLElement, text: string) => (_: string, el: Element | null) =>
  el?.parentElement === header && el.textContent === text;
const findCrumb = (header: HTMLElement, text: string) => within(header).findByText(crumbMatcher(header, text));
const queryCrumb = (header: HTMLElement, text: string) => within(header).queryByText(crumbMatcher(header, text));

describe('ChatHeader (D8)', () => {
  it('shows the project breadcrumb, then the title', async () => {
    const { header, project, chat } = await renderChat();
    const crumb = await findCrumb(header, `${project.name} /`);
    expect(crumb.textContent).toBe(`${project.name} /`);
    expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe(chat.title);
  });

  it('shows "Chats /" for a loose chat', async () => {
    const seed = await seededClient();
    const loose = await seed.client.createChat({ projectId: null, model: 'm' });
    renderApp({ client: seed.client, route: `/chat/${loose.id}` });
    expect(await screen.findByText('Chats /')).toBeTruthy();
  });
});

describe('Chat options (D9)', () => {
  it('Rename: selects the current title, calls updateChat, updates header and sidebar, returns focus', async () => {
    const { header, client, chat } = await renderChat();
    const update = vi.spyOn(client, 'updateChat');
    const trigger = optionsButton(header);
    openMenu(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename chat' });
    const input = within(dialog).getByLabelText('Title') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.value).toBe(chat.title);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, chat.title.length]);

    fireEvent.change(input, { target: { value: '  A better title  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(chat.id, { title: 'A better title' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('A better title');
    await waitFor(() => expect(document.title).toBe('A better title — OpenVern'));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('Rename: Save is disabled for a blank title', async () => {
    const { header } = await renderChat();
    openMenu(optionsButton(header));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename chat' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: '   ' } });
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Move to project: checks the current project and moves the chat (No project → "Chats /")', async () => {
    const { header, client, chat, project, projects } = await renderChat();
    const update = vi.spyOn(client, 'updateChat');
    openMenu(optionsButton(header));
    const sub = await screen.findByRole('menuitem', { name: 'Move to project' });
    sub.focus();
    fireEvent.keyDown(sub, { key: 'ArrowRight' });
    const current = await screen.findByRole('menuitemradio', { name: project.name });
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'No project' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(projects.length + 1);

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'No project' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(chat.id, { projectId: null }));
    expect(await within(header).findByText('Chats /')).toBeTruthy();
    // The sidebar re-groups: the chat now sits under CHATS.
    const heading = await screen.findByRole('heading', { name: 'Chats' });
    expect(within(heading.closest('section') as HTMLElement).getByRole('link', { name: chat.title })).toBeTruthy();
  });

  it('Move to project: moves into another project', async () => {
    const { header, client, chat, project, projects } = await renderChat();
    const update = vi.spyOn(client, 'updateChat');
    const target = projects.find((p) => p.id !== project.id);
    if (!target) throw new Error('seed missing');
    openMenu(optionsButton(header));
    const sub = await screen.findByRole('menuitem', { name: 'Move to project' });
    sub.focus();
    fireEvent.keyDown(sub, { key: 'ArrowRight' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: target.name }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(chat.id, { projectId: target.id }));
    expect(await findCrumb(header, `${target.name} /`)).toBeTruthy();
  });

  it('Delete: confirms, calls deleteChat and navigates to #/new', async () => {
    const { header, client, chat } = await renderChat();
    const del = vi.spyOn(client, 'deleteChat');
    openMenu(optionsButton(header));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(chat.id));
    await waitFor(() => expect(location()).toBe('/new'));
    expect(await screen.findByRole('heading', { level: 1, name: /What are we building/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('link', { name: chat.title })).toBeNull());
    expect(document.title).toBe('OpenVern');
  });

  it('Delete: Cancel keeps the chat', async () => {
    const { header, client } = await renderChat();
    const del = vi.spyOn(client, 'deleteChat');
    openMenu(optionsButton(header));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(del).not.toHaveBeenCalled();
    expect(location()).toMatch(/^\/chat\//);
  });
});

describe('Archive in chat options (D9)', () => {
  afterEach(() => useRunsStore.setState({ runs: {} }));

  /** A seeded client plus a loose chat titled "Loose chat", optionally archived already. */
  async function renderLoose(archived = false) {
    const seed = await seededClient();
    const loose = await seed.client.createChat({ projectId: null, model: 'm' });
    await seed.client.updateChat(loose.id, { title: 'Loose chat', ...(archived ? { archived: true } : {}) });
    const view = renderApp({ client: seed.client, route: `/chat/${loose.id}` });
    const header = (await screen.findByRole('heading', { level: 1, name: 'Loose chat' })).closest('header');
    if (!header) throw new Error('missing header');
    return { ...seed, ...view, loose, header };
  }
  const chatsSection = async () => {
    const section = (await screen.findByRole('heading', { name: 'Chats' })).closest('section');
    if (!section) throw new Error('missing section');
    return section;
  };

  it('Archive: calls updateChat, stays on the chat, shows "Archived /", files it under Archived, and offers Unarchive', async () => {
    const { header, client, loose } = await renderLoose();
    expect(await within(header).findByText('Chats /')).toBeTruthy();
    const update = vi.spyOn(client, 'updateChat');
    openMenu(optionsButton(header));
    expect(screen.queryByRole('menuitem', { name: 'Unarchive' })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(loose.id, { archived: true }));
    expect(await within(header).findByText('Archived /')).toBeTruthy();
    expect(within(header).queryByText('Chats /')).toBeNull();
    expect(location()).toBe(`/chat/${loose.id}`);

    const section = await chatsSection();
    const toggle = await within(section).findByRole('button', { name: /^Archived/ });
    expect(toggle.textContent).toBe('Archived1');
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
    expect(within(section).getByRole('link', { name: 'Loose chat' }).getAttribute('aria-current')).toBe('page');

    openMenu(optionsButton(header));
    expect(await screen.findByRole('menuitem', { name: 'Unarchive' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
  });

  it('Unarchive: calls updateChat, returns the chat to the Chats list and the breadcrumb to "Chats /"', async () => {
    const { header, client, loose } = await renderLoose(true);
    expect(await within(header).findByText('Archived /')).toBeTruthy();
    const update = vi.spyOn(client, 'updateChat');
    openMenu(optionsButton(header));
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unarchive' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(loose.id, { archived: false }));
    expect(await within(header).findByText('Chats /')).toBeTruthy();
    expect(within(header).queryByText('Archived /')).toBeNull();
    expect(location()).toBe(`/chat/${loose.id}`);

    const section = await chatsSection();
    await waitFor(() => expect(within(section).queryByRole('button', { name: /^Archived/ })).toBeNull());
    expect(within(section).getByRole('link', { name: 'Loose chat' }).getAttribute('aria-current')).toBe('page');

    openMenu(optionsButton(header));
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Unarchive' })).toBeNull();
  });

  it('a project chat offers Archive (not Unarchive)', async () => {
    const { header } = await renderChat();
    openMenu(optionsButton(header));
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Unarchive' })).toBeNull();
  });

  it.each([false, true])(
    'is disabled while a reply is running and selecting it does nothing (archived: %s)',
    async (archived) => {
      const seed = await seededClient();
      const loose = await seed.client.createChat({ projectId: null, model: 'm' });
      await seed.client.updateChat(loose.id, { title: 'Loose chat', ...(archived ? { archived: true } : {}) });
      useRunsStore.setState({ runs: { [loose.id]: createRun(1) } });
      const update = vi.spyOn(seed.client, 'updateChat');
      renderApp({ client: seed.client, route: `/chat/${loose.id}` });
      const header = (await screen.findByRole('heading', { level: 1, name: 'Loose chat' })).closest('header');
      if (!header) throw new Error('missing header');

      openMenu(optionsButton(header));
      const item = await screen.findByRole('menuitem', { name: archived ? 'Unarchive' : 'Archive' });
      expect(item.hasAttribute('data-disabled')).toBe(true);
      fireEvent.click(item);
      expect(update).not.toHaveBeenCalled();
    },
  );
});

describe('Archive in chat options for project chats (F2)', () => {
  afterEach(() => useRunsStore.setState({ runs: {} }));

  /** The seeded project chat, archived before render, with its header. */
  async function renderArchivedProjectChat() {
    const seed = await seededClient();
    await seed.client.updateChat(seed.chat.id, { archived: true });
    const view = renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    const header = (await screen.findByRole('heading', { level: 1, name: seed.chat.title })).closest('header');
    if (!header) throw new Error('missing header');
    return { ...seed, ...view, header };
  }

  it('shows Unarchive and the "PROJECT · ARCHIVED" crumb, then Unarchive restores both', async () => {
    const { header, client, chat, project } = await renderArchivedProjectChat();
    expect(await findCrumb(header, `${project.name} · Archived /`)).toBeTruthy();
    expect(queryCrumb(header, `${project.name} /`)).toBeNull();

    const update = vi.spyOn(client, 'updateChat');
    openMenu(optionsButton(header));
    expect(await screen.findByRole('menuitem', { name: 'Unarchive' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(chat.id, { archived: false }));
    expect(await findCrumb(header, `${project.name} /`)).toBeTruthy();
    expect(queryCrumb(header, `${project.name} · Archived /`)).toBeNull();
  });

  it('Unarchive is disabled while a reply is running', async () => {
    const seed = await seededClient();
    await seed.client.updateChat(seed.chat.id, { archived: true });
    useRunsStore.setState({ runs: { [seed.chat.id]: createRun(1) } });
    const update = vi.spyOn(seed.client, 'updateChat');
    renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    const header = (await screen.findByRole('heading', { level: 1, name: seed.chat.title })).closest('header');
    if (!header) throw new Error('missing header');

    openMenu(optionsButton(header));
    const item = await screen.findByRole('menuitem', { name: 'Unarchive' });
    expect(item.hasAttribute('data-disabled')).toBe(true);
    fireEvent.click(item);
    expect(update).not.toHaveBeenCalled();
  });

  it('puts " · Archived /" in its own span after the name and titles the crumb with its full text', async () => {
    const { header, project } = await renderArchivedProjectChat();
    const crumb = await findCrumb(header, `${project.name} · Archived /`);
    expect(crumb.getAttribute('title')).toBe(`${project.name} · Archived`);
    const [name, suffix] = Array.from(crumb.children);
    expect(crumb.children).toHaveLength(2);
    expect(name?.textContent).toBe(project.name);
    expect(suffix?.textContent).toBe(' · Archived /');
  });

  it('an active project crumb splits the same way, with " /" as the suffix', async () => {
    const { header, project } = await renderChat();
    const crumb = await findCrumb(header, `${project.name} /`);
    expect(crumb.getAttribute('title')).toBe(project.name);
    expect(Array.from(crumb.children).map((el) => el.textContent)).toEqual([project.name, ' /']);
  });

  it('an archived loose chat keeps the "Archived /" crumb', async () => {
    const seed = await seededClient();
    const loose = await seed.client.createChat({ projectId: null, model: 'm' });
    await seed.client.updateChat(loose.id, { title: 'Archived loose', archived: true });
    renderApp({ client: seed.client, route: `/chat/${loose.id}` });
    const header = (await screen.findByRole('heading', { level: 1, name: 'Archived loose' })).closest('header');
    if (!header) throw new Error('missing header');
    const crumb = await within(header).findByText('Archived /');
    expect(crumb.children).toHaveLength(0);
    expect(crumb.hasAttribute('title')).toBe(false);
    expect(within(header).queryByText('Chats /')).toBeNull();
  });
});
