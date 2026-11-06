// F2.7 (plan §6): the "Remove project" dialog shows the mutation's error inline, stays open, and a retry
// that succeeds closes it. Reopening clears the old error.

import { openMenu, renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { ApiError } from '@renderer/lib/api-client';
import { errorInfo } from '@shared/errors';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REMOVE_FAILED = "Some chats couldn't be read, so the project wasn't removed. Try again.";

beforeEach(resetUi);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openRemoveDialog(projectName: string) {
  const row = await screen.findByRole('button', { name: new RegExp(`^${projectName}`) });
  openMenu(screen.getByRole('button', { name: `Options for ${projectName}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
  const dialog = await screen.findByRole('dialog', { name: 'Remove project?' });
  expect(row).toBeTruthy();
  return dialog;
}

describe('Remove project dialog errors (F2.7)', () => {
  it('shows the mutation message inline and stays open when deleteProject fails', async () => {
    const { client, project } = await seededClient();
    vi.spyOn(client, 'deleteProject').mockRejectedValueOnce(new ApiError(errorInfo('conflict', REMOVE_FAILED), 409));
    renderApp({ client });

    const dialog = await openRemoveDialog(project.name);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(REMOVE_FAILED);
    expect(screen.getByRole('dialog', { name: 'Remove project?' })).toBe(dialog);
  });

  it('a retry that succeeds closes the dialog and removes the project', async () => {
    const { client, project } = await seededClient();
    vi.spyOn(client, 'deleteProject').mockRejectedValueOnce(new ApiError(errorInfo('conflict', REMOVE_FAILED), 409));
    renderApp({ client });

    const dialog = await openRemoveDialog(project.name);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await within(dialog).findByRole('alert');
    expect(screen.queryByRole('dialog')).not.toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(`^${project.name}`) })).toBeNull());
  });

  it('reopening after a failure does not show the old error', async () => {
    const { client, project } = await seededClient();
    vi.spyOn(client, 'deleteProject').mockRejectedValueOnce(new ApiError(errorInfo('conflict', REMOVE_FAILED), 409));
    renderApp({ client });

    const dialog = await openRemoveDialog(project.name);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await within(dialog).findByRole('alert');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const reopened = await openRemoveDialog(project.name);
    expect(within(reopened).queryByRole('alert')).toBeNull();
    expect(within(reopened).queryByText(REMOVE_FAILED)).toBeNull();
  });
});
