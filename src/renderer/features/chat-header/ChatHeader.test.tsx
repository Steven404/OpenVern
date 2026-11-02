import { location, openMenu, renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
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

describe('ChatHeader (D8)', () => {
  it('shows the project as an uppercase-by-CSS breadcrumb, then the title', async () => {
    const { header, project, chat } = await renderChat();
    const crumb = await within(header).findByText(`${project.name} /`);
    expect(crumb.className).toContain('uppercase');
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
    expect(await within(header).findByText(`${target.name} /`)).toBeTruthy();
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
