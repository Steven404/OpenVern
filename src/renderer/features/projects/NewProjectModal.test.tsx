import { location, renderApp, resetUi } from '@renderer/app/test-utils';
import { STORAGE_KEYS, useUiStore } from '@renderer/stores/ui';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderBasename } from './NewProjectModal';

beforeEach(resetUi);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.openvern = undefined;
});

async function openModal(opts: Parameters<typeof renderApp>[0] = {}) {
  const view = renderApp(opts);
  fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
  const dialog = await screen.findByRole('dialog', { name: 'New project' });
  return { ...view, dialog };
}

describe('folderBasename', () => {
  it('handles trailing slashes, ~ and Windows paths', () => {
    expect(folderBasename('/home/me/code/app/')).toBe('app');
    expect(folderBasename('C:\\code\\site')).toBe('site');
    expect(folderBasename('~')).toBe('');
    expect(folderBasename('  ')).toBe('');
  });
});

describe('NewProjectModal in the browser', () => {
  it('prefills the name from the folder, lets you edit it, and creates the project', async () => {
    const { dialog, client } = await openModal();
    const create = vi.spyOn(client, 'createProject');
    const folder = within(dialog).getByLabelText('Folder') as HTMLInputElement;
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    expect(folder.readOnly).toBe(false);
    expect((within(dialog).getByRole('button', { name: 'Add project' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(folder, { target: { value: '~/code/my-app' } });
    expect(name.value).toBe('my-app');
    fireEvent.change(name, { target: { value: 'My App' } });
    fireEvent.change(folder, { target: { value: '~/code/other' } });
    expect(name.value).toBe('My App'); // edited names stay

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ rootPath: '~/code/other', name: 'My App' }));
    const created = (await client.listProjects()).find((p) => p.name === 'My App');
    expect(created).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(location()).toBe(`/new?project=${created?.id}`));
    // The new project is expanded and listed in the sidebar.
    expect(useUiStore.getState().expandedProjects[created?.id ?? '']).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEYS.expandedProjects)).toContain(created?.id);
    const row = await screen.findByRole('button', { name: /^My App/ });
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows an inline error for an invalid path and clears it on edit', async () => {
    const { dialog } = await openModal();
    const folder = within(dialog).getByLabelText('Folder');
    fireEvent.change(folder, { target: { value: 'relative/path' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add project' }));
    expect(await within(dialog).findByText('Enter an absolute path to a folder.')).toBeTruthy();
    expect(folder.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
    fireEvent.change(folder, { target: { value: '/tmp/x' } });
    expect(within(dialog).queryByText('Enter an absolute path to a folder.')).toBeNull();
  });

  it('shows an inline error for a duplicate folder', async () => {
    const { dialog, client } = await openModal();
    const [existing] = await client.listProjects();
    if (!existing) throw new Error('seed missing');
    fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: existing.rootPath } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add project' }));
    expect(await within(dialog).findByText('This folder is already a project.')).toBeTruthy();
  });

  it('shows the platform-neutral ~/code/my-app placeholder and accepts a ~ path', async () => {
    const { dialog } = await openModal();
    const folder = within(dialog).getByLabelText('Folder') as HTMLInputElement;
    expect(folder.placeholder).toBe('~/code/my-app');
    fireEvent.change(folder, { target: { value: '~/code/my-app' } });
    expect(within(dialog).queryByText('Enter an absolute path to a folder.')).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Add project' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('starts empty each time it opens', async () => {
    const { dialog } = await openModal();
    fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: '/tmp/abc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    const again = await screen.findByRole('dialog', { name: 'New project' });
    expect((within(again).getByLabelText('Folder') as HTMLInputElement).value).toBe('');
  });
});

describe('NewProjectModal in Electron', () => {
  it('shows a read-only path and a Browse… button backed by pickDirectory()', async () => {
    const pickDirectory = vi.fn().mockResolvedValue('/home/you/code/picked-folder');
    window.openvern = { isElectron: true, pickDirectory };
    const { dialog, client } = await openModal();
    const create = vi.spyOn(client, 'createProject');
    const folder = within(dialog).getByLabelText('Folder') as HTMLInputElement;
    expect(folder.readOnly).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(folder.value).toBe('/home/you/code/picked-folder'));
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('picked-folder');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add project' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ rootPath: '/home/you/code/picked-folder', name: 'picked-folder' }),
    );
  });

  it('keeps the field unchanged when the picker is cancelled', async () => {
    window.openvern = { isElectron: true, pickDirectory: vi.fn().mockResolvedValue(null) };
    const { dialog } = await openModal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(window.openvern?.pickDirectory).toHaveBeenCalled());
    expect((within(dialog).getByLabelText('Folder') as HTMLInputElement).value).toBe('');
  });
});
