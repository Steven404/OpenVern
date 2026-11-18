import { errorInfo } from '@shared/errors';
import type { Chat, ChatSummary } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api-client';
import { MockApiClient } from '../lib/mock-api-client';
import { queryKeys } from '../lib/query-keys';
import {
  chatQueryOptions,
  confirmEditMode,
  EDIT_MODE_ERROR,
  fetchChat,
  forgetEditMode,
  noteAnswer,
  useEditModeEntry,
  useEditModes,
  writeChat,
} from './edit-modes';

beforeEach(() => useEditModes.setState({ entries: {} }));
afterEach(() => vi.restoreAllMocks());

/** A promise and the function that settles it, for holding a request open. */
function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function setup() {
  const api = new MockApiClient({ delayMs: 0 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const [project] = await api.listProjects();
  const chat = await api.createChat({ projectId: project?.id ?? null, model: 'anthropic/claude-sonnet-5.5' });
  return { api, queryClient, chat, deps: { api, queryClient } };
}
const entry = (id: string) => useEditModes.getState().entries[id];
/** A held `getChat` that answers with what the server had when it was called. */
function holdRead(api: MockApiClient) {
  const real = api.getChat.bind(api);
  const held = gate();
  vi.spyOn(api, 'getChat').mockImplementationOnce(async (id) => {
    const snapshot = await real(id);
    await held.promise;
    return snapshot;
  });
  return held;
}

describe('the shown edit mode', () => {
  it('an unknown id is loading; a read makes it known', async () => {
    const { api, chat } = await setup();
    const { result } = renderHook(() => useEditModeEntry('nope'));
    expect(result.current).toEqual({ mode: null, status: 'loading', error: null, barrier: 0 });
    expect(renderHook(() => useEditModeEntry(undefined)).result.current.status).toBe('loading');
    await fetchChat(api, chat.id);
    expect(entry(chat.id)).toMatchObject({ mode: 'review', status: 'known' });
  });

  it('a read that started before an answer is ignored even if it lands after; one started after is applied', async () => {
    const { api, chat } = await setup();
    const held = holdRead(api);
    const early = fetchChat(api, chat.id); // captures Review
    await api.updateChat(chat.id, { editMode: 'auto' });
    noteAnswer(chat.id, 'auto');
    held.open();
    await early;
    expect(entry(chat.id)).toMatchObject({ mode: 'auto', status: 'known' });

    await api.updateChat(chat.id, { editMode: 'review' }); // another window
    await fetchChat(api, chat.id);
    expect(entry(chat.id)).toMatchObject({ mode: 'review', status: 'known' });
  });

  it('a read that lands while a write is in flight is ignored', async () => {
    const { api, chat, deps } = await setup();
    await fetchChat(api, chat.id);
    const write = gate();
    const writing = writeChat(deps, chat.id, 'mode', async () => {
      await write.promise;
      return api.updateChat(chat.id, { editMode: 'auto' });
    });
    expect(entry(chat.id)?.status).toBe('saving');
    await api.updateChat(chat.id, { editMode: 'auto' }); // the server already has it; the answer is late
    await fetchChat(api, chat.id);
    expect(entry(chat.id)).toMatchObject({ mode: 'review', status: 'saving' });
    write.open();
    await writing;
    expect(entry(chat.id)).toMatchObject({ mode: 'auto', status: 'known' });
  });

  it('a failed write goes to confirming, then known; a failed confirm gives unknown; "Try again" gives known', async () => {
    const { api, chat, deps } = await setup();
    await fetchChat(api, chat.id);
    const read = gate();
    const real = api.getChat.bind(api);
    vi.spyOn(api, 'getChat').mockImplementationOnce(async (id) => {
      await read.promise;
      return real(id);
    });
    await expect(
      writeChat(deps, chat.id, 'mode', () => Promise.reject(new ApiError(errorInfo('internal'), 500))),
    ).rejects.toBeInstanceOf(ApiError);
    expect(entry(chat.id)).toMatchObject({ status: 'confirming', error: EDIT_MODE_ERROR });
    read.open();
    await vi.waitFor(() => expect(entry(chat.id)).toMatchObject({ mode: 'review', status: 'known' }));

    vi.spyOn(api, 'getChat').mockRejectedValueOnce(new Error('offline'));
    await expect(
      writeChat(deps, chat.id, 'mode', () => Promise.reject(new ApiError(errorInfo('internal'), 500))),
    ).rejects.toBeInstanceOf(ApiError);
    await vi.waitFor(() => expect(entry(chat.id)?.status).toBe('unknown'));

    await confirmEditMode(deps, chat.id);
    expect(entry(chat.id)).toMatchObject({ mode: 'review', status: 'known' });
  });

  it('a refused write keeps the server message as the error; a move sets no error', async () => {
    const { api, chat, deps } = await setup();
    await fetchChat(api, chat.id);
    const refusal = new ApiError(errorInfo('conflict', 'This chat moved to another project.'), 409);
    await expect(writeChat(deps, chat.id, 'mode', () => Promise.reject(refusal))).rejects.toBe(refusal);
    expect(entry(chat.id)?.error).toBe('This chat moved to another project.');
    await vi.waitFor(() => expect(entry(chat.id)?.status).toBe('known'));
    useEditModes.setState({ entries: { [chat.id]: { mode: 'review', status: 'known', error: null, barrier: 0 } } });
    await expect(writeChat(deps, chat.id, 'move', () => Promise.reject(refusal))).rejects.toBe(refusal);
    expect(entry(chat.id)?.error).toBeNull();
  });

  it('writeChat sends nothing and returns null unless the status allows it', async () => {
    const { api, chat, deps } = await setup();
    const request = vi.fn(async (): Promise<ChatSummary> => api.updateChat(chat.id, { editMode: 'auto' }));
    // loading
    expect(await writeChat(deps, chat.id, 'mode', request)).toBeNull();
    expect(await writeChat(deps, chat.id, 'move', request)).toBeNull();
    // saving: two picks in one tick send one PATCH
    await fetchChat(api, chat.id);
    const first = writeChat(deps, chat.id, 'mode', request);
    expect(await writeChat(deps, chat.id, 'mode', request)).toBeNull();
    expect(await writeChat(deps, chat.id, 'move', request)).toBeNull();
    await first;
    expect(request).toHaveBeenCalledTimes(1);
    // unknown: a mode pick is allowed (it is absolute), a move is not
    useEditModes.setState({ entries: { [chat.id]: { mode: 'auto', status: 'unknown', error: null, barrier: 0 } } });
    expect(await writeChat(deps, chat.id, 'move', request)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(await writeChat(deps, chat.id, 'mode', request)).toMatchObject({ editMode: 'auto' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(entry(chat.id)?.status).toBe('known');
    // confirming
    useEditModes.setState({ entries: { [chat.id]: { mode: 'auto', status: 'confirming', error: null, barrier: 0 } } });
    expect(await writeChat(deps, chat.id, 'mode', request)).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('a confirm cancels a read already in flight before it fetches, and ignores that read', async () => {
    const { api, chat, deps, queryClient } = await setup();
    await queryClient.fetchQuery(chatQueryOptions(api, chat.id));
    const held = holdRead(api); // captures Review
    const old = queryClient.fetchQuery({ ...chatQueryOptions(api, chat.id), staleTime: 0 }).catch(() => null);
    await api.updateChat(chat.id, { editMode: 'auto' }); // another window
    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    const confirming = confirmEditMode(deps, chat.id);
    expect(entry(chat.id)?.status).toBe('confirming');
    await confirming;
    expect(cancel).toHaveBeenCalledWith({ queryKey: queryKeys.chat(chat.id) });
    expect(entry(chat.id)).toMatchObject({ mode: 'auto', status: 'known' });
    held.open();
    await old;
    await new Promise((r) => setTimeout(r, 10));
    expect(entry(chat.id)).toMatchObject({ mode: 'auto', status: 'known' });
    expect(queryClient.getQueryData<Chat>(queryKeys.chat(chat.id))?.editMode).toBe('auto');
  });

  it('a confirm leaves a write in flight to settle itself', async () => {
    const { api, chat, deps } = await setup();
    await fetchChat(api, chat.id);
    const write = gate();
    const writing = writeChat(deps, chat.id, 'mode', async () => {
      await write.promise;
      return api.updateChat(chat.id, { editMode: 'auto' });
    });
    const getChat = vi.spyOn(api, 'getChat');
    await confirmEditMode(deps, chat.id);
    expect(getChat).not.toHaveBeenCalled();
    expect(entry(chat.id)?.status).toBe('saving');
    write.open();
    await writing;
    expect(entry(chat.id)).toMatchObject({ mode: 'auto', status: 'known' });
  });

  it('forgetEditMode drops the entry', async () => {
    const { chat } = await setup();
    noteAnswer(chat.id, 'auto');
    expect(entry(chat.id)?.mode).toBe('auto');
    forgetEditMode(chat.id);
    expect(entry(chat.id)).toBeUndefined();
    forgetEditMode(chat.id);
    expect(useEditModes.getState().entries).toEqual({});
  });
});
