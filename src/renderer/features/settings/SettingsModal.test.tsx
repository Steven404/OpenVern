import { renderApp, resetUi } from '@renderer/app/test-utils';
import { ApiError } from '@renderer/lib/api-client';
import { queryKeys } from '@renderer/lib/query-keys';
import { errorInfo } from '@shared/errors';
import type { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'sk-or-v1-0123456789abcdefWXYZ';
const HARNESS_DOWN = "Couldn't reach the harness server.";
const dump = (qc: QueryClient) =>
  JSON.stringify(
    qc
      .getMutationCache()
      .getAll()
      .map((m) => m.state),
  );
const expectNoKeyCached = (qc: QueryClient, ...keys: string[]) => {
  expect(
    qc
      .getMutationCache()
      .getAll()
      .every((m) => m.state.variables === undefined),
  ).toBe(true);
  for (const k of keys) expect(dump(qc)).not.toContain(k);
};

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

    const toggle = within(dialog).getByRole('button', { name: 'Show key' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByRole('button', { name: 'Show key' })).toBe(toggle);
    expect(within(dialog).queryByRole('button', { name: 'Hide key' })).toBeNull();
    fireEvent.click(toggle);
    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

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

  it('shows the server network_error copy', async () => {
    const { dialog, client } = await openSettings({ keyConfigured: false });
    vi.spyOn(client, 'setOpenRouterKey').mockRejectedValue(new ApiError(errorInfo('network_error')));
    fireEvent.change(await within(dialog).findByLabelText('API key'), { target: { value: 'sk-or-v1-abc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText("Couldn't reach OpenRouter. Check your connection.")).toBeTruthy();
  });

  it("save: shows the client's own network message (harness server down)", async () => {
    const { dialog, client } = await openSettings({ keyConfigured: false });
    vi.spyOn(client, 'setOpenRouterKey').mockRejectedValue(new ApiError(errorInfo('network_error', HARNESS_DOWN)));
    fireEvent.change(await within(dialog).findByLabelText('API key'), { target: { value: KEY } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(HARNESS_DOWN)).toBeTruthy();
    expect(within(dialog).queryByText(/Couldn't reach OpenRouter/)).toBeNull();
  });

  it('save: the key never stays in the mutation cache (success)', async () => {
    const { dialog, queryClient } = await openSettings({ keyConfigured: false });
    fireEvent.change(await within(dialog).findByLabelText('API key'), { target: { value: KEY } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/Connected/, {}, { timeout: 2000 })).toBeTruthy();
    expectNoKeyCached(queryClient, KEY);
  });

  it('save: the key never stays in the mutation cache (failure, then edit)', async () => {
    const { dialog, client, queryClient } = await openSettings({ keyConfigured: false });
    vi.spyOn(client, 'setOpenRouterKey').mockRejectedValue(new ApiError(errorInfo('network_error')));
    const input = await within(dialog).findByLabelText('API key');
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).not.toContain(KEY);
    expectNoKeyCached(queryClient, KEY);

    fireEvent.change(input, { target: { value: `${KEY}x` } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    const alert2 = await within(dialog).findByRole('alert');
    expect(alert2.textContent).not.toContain(KEY);
    expectNoKeyCached(queryClient, KEY, `${KEY}x`);
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

  it('Remove failure shows the error inside the confirm and keeps it open', async () => {
    const { dialog, client } = await openSettings();
    vi.spyOn(client, 'removeOpenRouterKey').mockRejectedValue(new ApiError(errorInfo('network_error', HARNESS_DOWN)));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove key' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove API key?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove key' }));
    const alert = await within(confirm).findByRole('alert');
    expect(alert.textContent).toBe(HARNESS_DOWN);
    expect(confirm.isConnected).toBe(true);
    expect(within(dialog).queryByRole('alert')).toBeNull();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove API key?' })).toBeNull());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    const reopened = await screen.findByRole('dialog', { name: 'Remove API key?' });
    expect(within(reopened).queryByRole('alert')).toBeNull();
  });

  it('Escape closes the modal and returns focus to the Settings button', async () => {
    const { dialog, opener } = await openSettings();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
