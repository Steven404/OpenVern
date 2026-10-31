import { renderApp, resetUi } from '@renderer/app/test-utils';
import { ApiError } from '@renderer/lib/api-client';
import { queryKeys } from '@renderer/lib/query-keys';
import { errorInfo } from '@shared/errors';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(resetUi);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openSettings(opts: { keyConfigured?: boolean } = {}) {
  const view = renderApp({ clientOptions: { keyConfigured: opts.keyConfigured } });
  const opener = await screen.findByRole('button', { name: 'Settings' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  return { ...view, dialog, opener };
}

describe('SettingsModal: no key configured', () => {
  it('shows a masked key field with show/hide, the OpenRouter link and a disabled Save', async () => {
    const { dialog } = await openSettings({ keyConfigured: false });
    expect(within(dialog).getByRole('heading', { name: 'OpenRouter' })).toBeTruthy();
    const input = (await within(dialog).findByLabelText('API key')) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.placeholder).toBe('sk-or-v1-…');
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Show key' }));
    expect(input.type).toBe('text');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide key' }));
    expect(input.type).toBe('password');

    const link = within(dialog).getByRole('link', { name: 'openrouter.ai/keys' });
    expect(link.getAttribute('href')).toBe('https://openrouter.ai/keys');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('shows "OpenRouter rejected this key." for a rejected key and keeps the form', async () => {
    const { dialog } = await openSettings({ keyConfigured: false });
    fireEvent.change(await within(dialog).findByLabelText('API key'), { target: { value: 'not-a-key' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('OpenRouter rejected this key.', {}, { timeout: 2000 })).toBeTruthy();
    expect(within(dialog).getByLabelText('API key')).toBeTruthy();
  });

  it('shows the network error copy', async () => {
    const { dialog, client } = await openSettings({ keyConfigured: false });
    vi.spyOn(client, 'setOpenRouterKey').mockRejectedValue(new ApiError(errorInfo('network_error')));
    fireEvent.change(await within(dialog).findByLabelText('API key'), { target: { value: 'sk-or-v1-abc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText("Couldn't reach OpenRouter. Check your connection.")).toBeTruthy();
  });

  it('shows a spinner while validating, then the connected state; invalidates models and settings', async () => {
    const { dialog, client, queryClient } = await openSettings({ keyConfigured: false });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const input = await within(dialog).findByLabelText('API key');
    fireEvent.change(input, { target: { value: 'sk-or-v1-0123456789abcdefWXYZ' } });
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => expect(save.getAttribute('aria-busy')).toBe('true'));
    expect(within(dialog).getByTestId('spinner')).toBeTruthy();
    expect(await within(dialog).findByText(/Connected/, {}, { timeout: 2000 })).toBeTruthy();
    expect(within(dialog).getByText('sk-or-v1-…WXYZ')).toBeTruthy();
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(queryKeys.models));
    expect(keys).toContain(JSON.stringify(queryKeys.settings));
    expect((await client.getSettings()).openRouter.configured).toBe(true);
  });
});

describe('SettingsModal: key configured', () => {
  it('shows "Connected · <hint>" with Replace key and Remove key', async () => {
    const { dialog } = await openSettings();
    expect(await within(dialog).findByText(/Connected/)).toBeTruthy();
    expect(within(dialog).getByText('sk-or-v1-…a1b2')).toBeTruthy();
    expect(within(dialog).queryByLabelText('API key')).toBeNull();
  });

  it('Replace key reveals the form and Cancel goes back', async () => {
    const { dialog } = await openSettings();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Replace key' }));
    expect(within(dialog).getByLabelText('API key')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await within(dialog).findByText(/Connected/)).toBeTruthy();
  });

  it('Remove key asks for confirmation, then removes it, invalidates models and shows the form', async () => {
    const { dialog, client, queryClient } = await openSettings();
    const remove = vi.spyOn(client, 'removeOpenRouterKey');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove key' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove API key?' });
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByLabelText('API key')).toBeTruthy();
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(queryKeys.models));
  });

  it('Escape closes the modal and returns focus to the Settings button', async () => {
    const { dialog, opener } = await openSettings();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
