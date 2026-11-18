// The edit mode each chat shows (the Review / Auto chip), one entry per chat id. The chip, Retry, Move and the
// composer's send gate all render from here, and every action that can edit files sends the value that was rendered,
// never a cache read at the moment it fires. The server refuses a turn, a move or an Auto switch whose expected mode
// (or project) is not the one it has, so a wrong value here can only cause a refusal, never a turn in a mode the user
// wasn't shown. Entries live for the session, so a write or a check in flight still settles after the composer
// unmounts, and a remounted composer sees it.

import type { Chat, ChatSummary, EditMode, Id } from '@shared/types';
import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { type ApiClient, ApiError } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';

/**
 * `loading`: nothing read yet · `known`: the mode the server had at the last trusted read or answer · `saving`: a mode
 * or move PATCH is in flight · `confirming`: a read is checking the server's mode (after a failed write or a refused
 * turn) · `unknown`: that read failed, so what the chip shows may not be the server's mode.
 */
export type ModeStatus = 'loading' | 'known' | 'saving' | 'confirming' | 'unknown';

export interface ModeEntry {
  /** What the chip shows; null until the first trusted read or answer. */
  mode: EditMode | null;
  status: ModeStatus;
  /** The last failed mode change, for the composer's notice. */
  error: string | null;
  /** Reads stamped at or before this tick are ignored: they may have started before the server took a newer mode. */
  barrier: number;
}

export const EDIT_MODE_ERROR = "Couldn't change the edit mode. Try again.";
export const EDIT_MODE_UNKNOWN = "Couldn't check this chat's edit mode, so sending is paused.";

const LOADING: ModeEntry = { mode: null, status: 'loading', error: null, barrier: 0 };

/** A module-level, monotonic clock: it orders the start of a read against the arrival of an answer. */
let clock = 0;
const tick = () => ++clock;

export const useEditModes = create<{ entries: Record<Id, ModeEntry> }>(() => ({ entries: {} }));

const entryOf = (id: Id): ModeEntry => useEditModes.getState().entries[id] ?? LOADING;
const setEntry = (id: Id, f: (e: ModeEntry) => ModeEntry) =>
  useEditModes.setState((s) => ({ entries: { ...s.entries, [id]: f(s.entries[id] ?? LOADING) } }));

/** The chat's entry; `loading` for an unknown id or none. */
export const useEditModeEntry = (id?: Id): ModeEntry => useEditModes((s) => (id && s.entries[id]) || LOADING);

export interface EditModeDeps {
  api: ApiClient;
  queryClient: QueryClient;
}

/**
 * ORDERING RULE (invariant): only three inputs set the shown mode: a chat GET that started after the last
 * mode-carrying answer arrived (and isn't racing a write in flight), the answer to a PATCH that carries the mode (a
 * mode change or a move), and the `createChat` answer. Run reports (`chat_updated`), summary patches and
 * `setQueryData` never do, so an older response can't put the old mode back on the chip.
 */
function noteRead(id: Id, mode: EditMode, startedAt: number) {
  setEntry(id, (e) => {
    if (e.status === 'saving' || startedAt <= e.barrier) return e;
    return { ...e, mode, status: 'known' };
  });
}

/** The `createChat` answer (or a chat the caller knows the server just returned): trusted, and a new barrier. */
export function noteAnswer(id: Id, mode: EditMode) {
  setEntry(id, (e) => ({ ...e, mode, status: 'known', barrier: tick() }));
}

/** Every chat-detail read goes through here, so its result can feed the shown mode (see `noteRead`). */
export async function fetchChat(api: ApiClient, id: Id): Promise<Chat> {
  const startedAt = tick();
  const chat = await api.getChat(id);
  noteRead(id, chat.editMode, startedAt);
  return chat;
}

/**
 * The one query definition for `queryKeys.chat(id)`. A query on that key with another queryFn would not feed the
 * shown mode: the chip would stay `loading` (send blocked) or behind until the next stamped read.
 */
export const chatQueryOptions = (api: ApiClient, id: Id) => ({
  queryKey: queryKeys.chat(id),
  queryFn: () => fetchChat(api, id),
});

/**
 * Reads the chat again so the chip shows the server's mode, after a failed write or a refused turn. Any read already
 * in flight may have started before the server took a newer mode: the barrier makes it count for nothing, and it is
 * cancelled so react-query doesn't hand it back for this fetch. A failed read leaves the entry `unknown` (sending
 * stays blocked until "Try again" or a later read succeeds). While a write is in flight its own answer settles it.
 */
export async function confirmEditMode(deps: EditModeDeps, id: Id): Promise<void> {
  if (entryOf(id).status === 'saving') return;
  setEntry(id, (e) => ({ ...e, status: 'confirming', barrier: tick() }));
  try {
    await deps.queryClient.cancelQueries({ queryKey: queryKeys.chat(id) });
    await deps.queryClient.fetchQuery({ ...chatQueryOptions(deps.api, id), staleTime: 0 });
  } catch {
    // Settled below.
  }
  setEntry(id, (e) => (e.status === 'confirming' ? { ...e, status: 'unknown' } : e));
  void deps.queryClient.invalidateQueries({ queryKey: queryKeys.chats });
}

/**
 * A PATCH that carries the mode: a chip change (`mode`) or a move (`move`). One at a time: unless the entry is `known`
 * (or `unknown` for a mode pick, which is absolute and resolves the doubt), nothing is sent and this returns null, so
 * two picks in one tick can't both go out. On success the answer is the shown mode, and the caller patches the
 * summary caches with the returned summary. On failure the entry is checked again with a fresh read and the error is
 * rethrown for the caller's own error UI.
 */
export async function writeChat(
  deps: EditModeDeps,
  id: Id,
  kind: 'mode' | 'move',
  request: () => Promise<ChatSummary>,
): Promise<ChatSummary | null> {
  const { status } = entryOf(id);
  if (status !== 'known' && !(kind === 'mode' && status === 'unknown')) return null;
  setEntry(id, (e) => ({ ...e, status: 'saving', ...(kind === 'mode' ? { error: null } : {}) }));
  let summary: ChatSummary;
  try {
    summary = await request();
  } catch (err) {
    const error =
      err instanceof ApiError && err.info.code === 'conflict' && err.info.message ? err.info.message : EDIT_MODE_ERROR;
    setEntry(id, (e) => ({ ...e, status: 'confirming', barrier: tick(), ...(kind === 'mode' ? { error } : {}) }));
    void confirmEditMode(deps, id);
    throw err;
  }
  setEntry(id, (e) => ({ ...e, mode: summary.editMode, status: 'known', barrier: tick() }));
  // Reads started from here on are stamped after the barrier, so they are trusted.
  void deps.queryClient.invalidateQueries({ queryKey: queryKeys.chat(id) });
  void deps.queryClient.invalidateQueries({ queryKey: queryKeys.chats });
  return summary;
}

/** After the chat was deleted. */
export function forgetEditMode(id: Id) {
  useEditModes.setState((s) => {
    if (!(id in s.entries)) return s;
    const { [id]: _gone, ...rest } = s.entries;
    return { entries: rest };
  });
}
