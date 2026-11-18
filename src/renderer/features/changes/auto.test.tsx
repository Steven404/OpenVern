import { renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { ApiError } from '@renderer/lib/api-client';
import { makeFileChange, makeHunk, sampleAutoBatch, sampleProposal } from '@renderer/lib/mock-changes';
import { createRun, useRunsStore } from '@renderer/stores/runs';
import { useUiStore } from '@renderer/stores/ui';
import { errorInfo } from '@shared/errors';
import type { AppliedBatch, ChatChanges, PendingChanges } from '@shared/types';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPanelSurface, usePanelStore } from '../right-panel/panel-store';
import { useReviewStore } from './review-store';

beforeEach(() => {
  resetUi();
  usePanelStore.setState({ chats: {} });
  useReviewStore.setState({ chats: {} });
  useRunsStore.setState({ runs: {} });
  window.innerWidth = 1600;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = '2026-01-01T10:00:00.000Z';

function autoBatch(over: Partial<AppliedBatch> = {}): AppliedBatch {
  return {
    id: 'ab1',
    appliedAt: NOW,
    messageId: 'm1',
    written: sampleAutoBatch(),
    rejectedHunks: 0,
    skippedHunks: 0,
    conflicts: [],
    source: 'auto',
    turnId: 'u1',
    undoable: true,
    ...over,
  };
}

/** The seeded Auto chat ("Streaming replies over SSE") with its one undoable auto batch. */
async function seededAuto() {
  const seed = await seededClient();
  const chat = seed.chats.find((c) => c.title === 'Streaming replies over SSE');
  if (!chat) throw new Error('seed lost the Auto chat');
  const changes = await seed.client.getChatChanges(chat.id);
  const batch = changes.applied[0] as AppliedBatch;
  return { ...seed, chat, batch, changes };
}

async function renderAutoChat() {
  const seed = await seededAuto();
  const view = renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
  await screen.findByRole('heading', { level: 1, name: seed.chat.title });
  return { ...seed, ...view };
}

/** Renders the chat with `getChatChanges` answering `changes` (and `getChat` as stored). */
async function renderWithChanges(changes: ChatChanges) {
  const seed = await seededAuto();
  // Fabricated batches sit under the seeded reply's turn, which is where a card is placed.
  const placed = {
    ...changes,
    applied: changes.applied.map((b) => (b.messageId === 'm1' ? { ...b, messageId: seed.batch.messageId } : b)),
  };
  vi.spyOn(seed.client, 'getChatChanges').mockResolvedValue(placed);
  const view = renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
  await screen.findByRole('heading', { level: 1, name: seed.chat.title });
  return { ...seed, ...view };
}

const autoCard = () => screen.findByTestId('auto-edits-card');
const panel = () => screen.getByRole('complementary', { name: 'Right panel' });

function openDiff(chatId: string, params: unknown = {}) {
  act(() => {
    useUiStore.getState().setRightPanelOpen(true);
    openPanelSurface(chatId, 'diff', params);
  });
}

describe('Auto card', () => {
  it('is labelled "Edits applied · Auto", lists the files and carries the batch id and undo state', async () => {
    const { batch } = await renderAutoChat();
    const card = await autoCard();
    expect(card.getAttribute('aria-label')).toBe('Edits applied · Auto');
    expect(card.getAttribute('data-undo')).toBe('undoable');
    expect(card.getAttribute('data-batch-id')).toBe(batch.id);
    expect(within(card).getByText('Edits applied')).toBeTruthy();
    expect(within(card).getByText('Auto')).toBeTruthy();
    expect(within(card).getByText('2 files')).toBeTruthy();
    expect(within(card).getByText(/Written as the model worked/)).toBeTruthy();
    expect(within(card).getByTestId('undo-button')).toBeTruthy();
    // A Review card keeps its own test id: the Auto card is not a changes-card.
    expect(screen.queryByTestId('changes-card')).toBeNull();
  });

  it('a Review batch keeps the plain card: no Auto badge, no Undo', async () => {
    const { client, chat, batch } = await seededAuto();
    const review: AppliedBatch = { ...batch, id: 'rb', source: 'review', undoable: false, turnId: undefined };
    vi.spyOn(client, 'getChatChanges').mockResolvedValue({ pending: null, applied: [review], diskSeq: 1 });
    renderApp({ client, route: `/chat/${chat.id}` });
    const card = await screen.findByTestId('changes-card');
    expect(card.getAttribute('aria-label')).toBe('Edits applied');
    expect(card.getAttribute('data-undo')).toBeNull();
    expect(within(card).queryByTestId('undo-button')).toBeNull();
    expect(screen.queryByTestId('auto-edits-card')).toBeNull();
  });

  it('Undo opens a dialog that lists the files; Cancel closes it without calling the server', async () => {
    const { client, batch } = await renderAutoChat();
    const undo = vi.spyOn(client, 'undoChatBatch');
    fireEvent.click(within(await autoCard()).getByTestId('undo-button'));
    const dialog = await screen.findByTestId('undo-dialog');
    expect(within(dialog).getByText("Undo this turn's edits?")).toBeTruthy();
    for (const f of batch.written) expect(within(dialog).getByText(f.path)).toBeTruthy();
    expect(dialog.textContent).toContain('A file that changed after the turn is left as it is.');
    fireEvent.click(within(dialog).getByTestId('undo-cancel'));
    await waitFor(() => expect(screen.queryByTestId('undo-dialog')).toBeNull());
    expect(undo).not.toHaveBeenCalled();
    expect((await autoCard()).getAttribute('data-undo')).toBe('undoable');
  });

  it('confirm calls undoChatBatch(chatId, batchId), closes the dialog and shows "Undone · N files restored"', async () => {
    const { client, chat, batch } = await renderAutoChat();
    const undo = vi.spyOn(client, 'undoChatBatch');
    fireEvent.click(within(await autoCard()).getByTestId('undo-button'));
    fireEvent.click(within(await screen.findByTestId('undo-dialog')).getByTestId('undo-confirm'));
    await waitFor(() => expect(screen.queryByTestId('undo-dialog')).toBeNull());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith(chat.id, batch.id);
    const card = await autoCard();
    await waitFor(() => expect(card.getAttribute('data-undo')).toBe('undone'));
    const status = within(card).getByTestId('undo-status');
    expect(status.getAttribute('data-state')).toBe('undone');
    expect(status.getAttribute('data-by')).toBe('user');
    expect(status.textContent).toBe('Undone · 2 files restored');
    expect(within(card).queryByTestId('undo-button')).toBeNull();
    // Focus goes to the status that replaced the button, not to the page.
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it('a second click on confirm while the request is in flight sends nothing more', async () => {
    const { client } = await renderAutoChat();
    let release: () => void = () => {};
    const real = client.undoChatBatch.bind(client);
    const undo = vi
      .spyOn(client, 'undoChatBatch')
      .mockImplementation((...args) => new Promise((resolve) => (release = () => resolve(real(...args)))));
    fireEvent.click(within(await autoCard()).getByTestId('undo-button'));
    const confirm = within(await screen.findByTestId('undo-dialog')).getByTestId('undo-confirm') as HTMLButtonElement;
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(confirm);
    expect(undo).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(screen.queryByTestId('undo-dialog')).toBeNull());
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('Undo is disabled while the chat runs, with a reason, and confirm is disabled if a run starts under the dialog', async () => {
    const { chat } = await renderAutoChat();
    const card = await autoCard();
    const button = within(card).getByTestId('undo-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    const confirm = within(await screen.findByTestId('undo-dialog')).getByTestId('undo-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    act(() => useRunsStore.setState({ runs: { [chat.id]: createRun(1) } }));
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(confirm.getAttribute('title')).toBe('Wait for the reply to finish');
    fireEvent.click(within(screen.getByTestId('undo-dialog')).getByTestId('undo-cancel'));
    await waitFor(() => expect(screen.queryByTestId('undo-dialog')).toBeNull());
    expect((within(card).getByTestId('undo-button') as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByTestId('undo-button').getAttribute('title')).toBe('Wait for the reply to finish');

    act(() => useRunsStore.setState({ runs: {} }));
    await waitFor(() => expect((within(card).getByTestId('undo-button') as HTMLButtonElement).disabled).toBe(false));
  });

  it('Undo is also disabled while a run is settling', async () => {
    const { chat } = await renderAutoChat();
    act(() => useRunsStore.setState({ runs: { [chat.id]: { ...createRun(1), status: 'settling' } } }));
    const card = await autoCard();
    await waitFor(() => expect((within(card).getByTestId('undo-button') as HTMLButtonElement).disabled).toBe(true));
  });

  it("shows the server's refusal in the dialog, keeps it open, and refetches the changes", async () => {
    const { client, batch } = await renderAutoChat();
    const message = 'These edits can no longer be undone.';
    vi.spyOn(client, 'undoChatBatch').mockRejectedValue(new ApiError(errorInfo('conflict', message), 409));
    const refetch = vi.spyOn(client, 'getChatChanges');
    const calls = refetch.mock.calls.length;
    fireEvent.click(within(await autoCard()).getByTestId('undo-button'));
    fireEvent.click(within(await screen.findByTestId('undo-dialog')).getByTestId('undo-confirm'));
    const error = await screen.findByTestId('undo-error');
    expect(error.textContent).toBe(message);
    expect(screen.getByTestId('undo-dialog')).toBeTruthy();
    await waitFor(() => expect(refetch.mock.calls.length).toBeGreaterThan(calls));
    // Still undoable in the cache the server just confirmed: the card is unchanged.
    expect((await autoCard()).getAttribute('data-batch-id')).toBe(batch.id);
    // Cancel clears the error: reopening starts clean.
    fireEvent.click(within(screen.getByTestId('undo-dialog')).getByTestId('undo-cancel'));
    await waitFor(() => expect(screen.queryByTestId('undo-dialog')).toBeNull());
    fireEvent.click(within(await autoCard()).getByTestId('undo-button'));
    await screen.findByTestId('undo-dialog');
    expect(screen.queryByTestId('undo-error')).toBeNull();
  });

  it('a batch undone elsewhere: the click is refused, the message shows, and the card then reads as undone', async () => {
    const { client, chat, batch } = await renderAutoChat();
    const card = await autoCard();
    expect(card.getAttribute('data-undo')).toBe('undoable');
    // Undone behind the UI's back (another window); the cached card still offers Undo.
    await client.undoChatBatch(chat.id, batch.id);
    fireEvent.click(within(card).getByTestId('undo-button'));
    fireEvent.click(within(await screen.findByTestId('undo-dialog')).getByTestId('undo-confirm'));
    expect((await screen.findByTestId('undo-error')).textContent).toBe('These edits can no longer be undone.');
    await waitFor(() => expect(card.getAttribute('data-undo')).toBe('undone'));
    expect(within(card).getByTestId('undo-status').getAttribute('data-by')).toBe('user');
  });

  it('a network failure shows a generic message', async () => {
    const { client } = await renderAutoChat();
    vi.spyOn(client, 'undoChatBatch').mockRejectedValue(new Error('socket hang up'));
    fireEvent.click(within(await autoCard()).getByTestId('undo-button'));
    fireEvent.click(within(await screen.findByTestId('undo-dialog')).getByTestId('undo-confirm'));
    expect((await screen.findByTestId('undo-error')).textContent).toBe("Couldn't undo the edits. Try again.");
  });

  it('cannot be dismissed while the undo request is in flight', async () => {
    const { client } = await renderAutoChat();
    let release: () => void = () => {};
    const real = client.undoChatBatch.bind(client);
    vi.spyOn(client, 'undoChatBatch').mockImplementation(
      (...args) => new Promise((resolve) => (release = () => resolve(real(...args)))),
    );
    fireEvent.click(within(await autoCard()).getByTestId('undo-button'));
    const dialog = await screen.findByTestId('undo-dialog');
    fireEvent.click(within(dialog).getByTestId('undo-confirm'));
    await waitFor(() => expect((within(dialog).getByTestId('undo-cancel') as HTMLButtonElement).disabled).toBe(true));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByTestId('undo-dialog')).toBeTruthy();
    await act(async () => release());
    await waitFor(() => expect(screen.queryByTestId('undo-dialog')).toBeNull());
  });
});

describe('Auto card footers', () => {
  const undone = (by: 'user' | 'retry', skipped: NonNullable<AppliedBatch['undo']>['skipped'] = []) =>
    autoBatch({
      undoable: false,
      undo: { at: NOW, by, restored: ['src/server/sse.ts'], skipped },
    });

  async function cardFor(batch: AppliedBatch) {
    await renderWithChanges({ pending: null, applied: [batch], diskSeq: 1 });
    return autoCard();
  }

  it('undone by the user: "Undone · N files restored" and no Undo button', async () => {
    const card = await cardFor(undone('user'));
    expect(card.getAttribute('data-undo')).toBe('undone');
    const status = within(card).getByTestId('undo-status');
    expect(status.getAttribute('data-by')).toBe('user');
    expect(status.textContent).toBe('Undone · 1 file restored');
    expect(within(card).queryByTestId('undo-button')).toBeNull();
    expect(within(card).queryByTestId('undo-skipped')).toBeNull();
  });

  it('undone by a retry: "Undone by a retry"', async () => {
    const card = await cardFor(undone('retry'));
    const status = within(card).getByTestId('undo-status');
    expect(status.getAttribute('data-state')).toBe('undone');
    expect(status.getAttribute('data-by')).toBe('retry');
    expect(status.textContent).toBe('Undone by a retry');
  });

  it('names a file the undo left alone, for each reason', async () => {
    const card = await cardFor(
      undone('user', [
        { path: 'src/server/app.ts', reason: 'changed_since' },
        { path: 'src/server/sse.ts', reason: 'unavailable' },
        { path: 'src/other.ts', reason: 'blocked' },
      ]),
    );
    const skipped = within(card).getByTestId('undo-skipped');
    const items = within(skipped)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual([
      'src/server/app.ts changed since, left as it is',
      'src/server/sse.ts: its earlier content is no longer available',
      "src/other.ts couldn't be restored",
    ]);
  });

  it('not undoable: "Undo no longer available" and no Undo button', async () => {
    const card = await cardFor(autoBatch({ undoable: false }));
    expect(card.getAttribute('data-undo')).toBe('unavailable');
    const status = within(card).getByTestId('undo-status');
    expect(status.getAttribute('data-state')).toBe('unavailable');
    expect(status.textContent).toBe('Undo no longer available');
    expect(within(card).queryByTestId('undo-button')).toBeNull();
  });

  it('an undone batch is never offered again, even if the server still says undoable', async () => {
    const card = await cardFor(
      autoBatch({ undoable: true, undo: { at: NOW, by: 'user', restored: ['a'], skipped: [] } }),
    );
    expect(card.getAttribute('data-undo')).toBe('undone');
    expect(within(card).queryByTestId('undo-button')).toBeNull();
  });
});

describe('Auto card file rows', () => {
  it('open the Diff panel with { batchId, path }', async () => {
    const { chat, batch } = await renderAutoChat();
    const card = await autoCard();
    fireEvent.click(within(card).getByRole('button', { name: /sse\.ts/ }));
    expect(usePanelStore.getState().chats[chat.id]?.active).toEqual({ type: 'surface', id: 'diff' });
    expect(usePanelStore.getState().chats[chat.id]?.params.diff).toEqual({
      batchId: batch.id,
      path: 'src/server/sse.ts',
    });
    const p = await waitFor(() => panel());
    const history = await within(p).findByRole('region', { name: 'History' });
    const entry = within(history).getByTestId('applied-batch');
    expect(entry.getAttribute('data-batch-id')).toBe(batch.id);
    const file = within(entry).getByRole('button', { name: /sse\.ts/ });
    expect(file.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(entry)
        .getByRole('button', { name: /app\.ts/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(within(entry).getByText(/export function toSSE/)).toBeTruthy();
  });
});

describe('Diff panel: Auto', () => {
  it('shows the Auto empty state when nothing is pending, with the History below', async () => {
    const { chat } = await renderAutoChat();
    openDiff(chat.id);
    const p = await waitFor(() => panel());
    expect(
      await within(p).findByText(
        'Nothing is waiting for review. In Auto, edits are written as the model works; undo a turn below.',
      ),
    ).toBeTruthy();
    expect(within(p).queryByText('No edits are waiting for review.')).toBeNull();
    const history = within(p).getByRole('region', { name: 'History' });
    expect(within(history).getByRole('heading', { name: 'History' })).toBeTruthy();
    const entry = within(history).getByTestId('applied-batch');
    expect(entry.getAttribute('data-source')).toBe('auto');
    expect(within(entry).getByText('Auto')).toBeTruthy();
    expect(within(entry).getByTestId('undo-button')).toBeTruthy();
  });

  it('a Review chat with only history keeps the Review empty state', async () => {
    const { client, chat, batch } = await seededAuto();
    await client.updateChat(chat.id, { editMode: 'review' });
    vi.spyOn(client, 'getChatChanges').mockResolvedValue({
      pending: null,
      applied: [{ ...batch, id: 'rb', source: 'review', undoable: false }],
      diskSeq: 1,
    });
    renderApp({ client, route: `/chat/${chat.id}` });
    await screen.findByRole('heading', { level: 1, name: chat.title });
    openDiff(chat.id);
    const p = await waitFor(() => panel());
    expect(await within(p).findByText('No edits are waiting for review.')).toBeTruthy();
    expect(within(p).getByTestId('applied-batch').getAttribute('data-source')).toBe('review');
    expect(within(p).queryByTestId('undo-button')).toBeNull();
  });

  it('undo from the History updates the History entry and the card in the conversation', async () => {
    const { client, chat, batch } = await renderAutoChat();
    const undo = vi.spyOn(client, 'undoChatBatch');
    openDiff(chat.id);
    const p = await waitFor(() => panel());
    const history = await within(p).findByRole('region', { name: 'History' });
    fireEvent.click(within(history).getByTestId('undo-button'));
    fireEvent.click(within(await screen.findByTestId('undo-dialog')).getByTestId('undo-confirm'));
    await waitFor(() => expect(screen.queryByTestId('undo-dialog')).toBeNull());
    expect(undo).toHaveBeenCalledWith(chat.id, batch.id);
    await waitFor(() => expect(within(history).getByTestId('undo-status').getAttribute('data-state')).toBe('undone'));
    expect(within(history).getByTestId('undo-status').textContent).toBe('Undone · 2 files restored');
    expect((await autoCard()).getAttribute('data-undo')).toBe('undone');
  });

  it('lists the files an undo skipped under the History entry', async () => {
    const batch = autoBatch({
      undoable: false,
      undo: {
        at: NOW,
        by: 'user',
        restored: ['src/server/sse.ts'],
        skipped: [{ path: 'src/server/app.ts', reason: 'changed_since' }],
      },
    });
    const { chat } = await renderWithChanges({ pending: null, applied: [batch], diskSeq: 2 });
    openDiff(chat.id);
    const history = await within(panel()).findByRole('region', { name: 'History' });
    const entry = within(history).getByTestId('applied-batch');
    expect(within(entry).getByTestId('undo-skipped').textContent).toBe(
      'src/server/app.ts changed since, left as it is',
    );
  });

  it('shows pending proposals on top and a History below it with an Auto batch and its Undo', async () => {
    const { client, chat, batch } = await seededAuto();
    // A Review turn after the Auto turn: the proposal is pending, the Auto batch stays in the History.
    await client.updateChat(chat.id, { editMode: 'review' });
    for await (const _ of client.sendMessage(
      chat.id,
      { text: 'propose [mock:edit]', attachmentIds: [], model: chat.model },
      new AbortController().signal,
    )) {
      // drain
    }
    renderApp({ client, route: `/chat/${chat.id}` });
    await screen.findByRole('heading', { level: 1, name: chat.title });
    openDiff(chat.id);
    const p = await waitFor(() => panel());
    const review = await within(p).findByRole('region', { name: 'Review changes' });
    const history = within(p).getByRole('region', { name: 'History' });
    expect(within(p).getByRole('button', { name: /Apply|Discard/ })).toBeTruthy();
    // Document order: the pending review pane first, the History after it.
    expect(review.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const entry = within(history).getByTestId('applied-batch');
    expect(entry.getAttribute('data-batch-id')).toBe(batch.id);
    expect(entry.getAttribute('data-source')).toBe('auto');
    expect(within(entry).getByTestId('undo-button')).toBeTruthy();
    // The proposal's files are not in the History.
    expect(within(history).queryByText(/write-file\.ts/)).toBeNull();
  });

  it("an Auto turn after an apply does not hide the apply's conflicts on the pending files", async () => {
    const files = sampleProposal();
    const first = files[0] as (typeof files)[number];
    const pending: PendingChanges = {
      revision: 3,
      messageId: 'm9',
      files: [first],
      totalAdd: first.add,
      totalDel: first.del,
    };
    const review: AppliedBatch = {
      id: 'rb',
      appliedAt: NOW,
      messageId: 'm2',
      written: [],
      rejectedHunks: 0,
      skippedHunks: 0,
      conflicts: [{ path: first.path, reason: 'changed_on_disk' }],
      source: 'review',
      undoable: false,
    };
    const { chat } = await renderWithChanges({ pending, applied: [review, autoBatch()], diskSeq: 2 });
    openDiff(chat.id);
    const p = await waitFor(() => panel());
    expect((await within(p).findAllByText('Changed on disk')).length).toBeGreaterThan(0);
  });
});

describe('Diff panel: batchId targeting', () => {
  const same = (hunkText: string, id: string): AppliedBatch =>
    autoBatch({
      id,
      written: [makeFileChange('src/a.ts', 'modify', [makeHunk(1, 1, '', ['-old', `+${hunkText}`])])],
    });

  async function twoBatches() {
    const first = same('FIRST_VERSION', 'b-first');
    const second = same('SECOND_VERSION', 'b-second');
    // Oldest first: the second batch is the newest and renders on top.
    const view = await renderWithChanges({ pending: null, applied: [first, second], diskSeq: 4 });
    return { ...view, first, second };
  }

  const entry = (p: HTMLElement, id: string) =>
    within(p)
      .getAllByTestId('applied-batch')
      .find((el) => el.getAttribute('data-batch-id') === id) as HTMLElement;

  it('opens the file of the targeted batch, not the same path in another batch', async () => {
    const { chat, first, second } = await twoBatches();
    openDiff(chat.id, { batchId: first.id, path: 'src/a.ts' });
    const p = await waitFor(() => panel());
    await within(p).findByRole('region', { name: 'History' });
    await waitFor(() => expect(within(entry(p, first.id)).getByText(/FIRST_VERSION/)).toBeTruthy());
    expect(within(entry(p, second.id)).queryByText(/SECOND_VERSION/)).toBeNull();
    expect(within(entry(p, first.id)).getByRole('button', { name: /a\.ts/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(within(entry(p, second.id)).getByRole('button', { name: /a\.ts/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );

    // A second request for the other batch opens that one too.
    openDiff(chat.id, { batchId: second.id, path: 'src/a.ts' });
    await waitFor(() => expect(within(entry(p, second.id)).getByText(/SECOND_VERSION/)).toBeTruthy());
  });

  it('repeating the same request opens a file the user closed in between', async () => {
    const { chat, first } = await twoBatches();
    openDiff(chat.id, { batchId: first.id, path: 'src/a.ts' });
    const p = await waitFor(() => panel());
    await within(p).findByRole('region', { name: 'History' });
    const row = () => within(entry(p, first.id)).getByRole('button', { name: /a\.ts/ });
    await waitFor(() => expect(row().getAttribute('aria-expanded')).toBe('true'));
    fireEvent.click(row());
    expect(row().getAttribute('aria-expanded')).toBe('false');
    openDiff(chat.id, { batchId: first.id, path: 'src/a.ts' });
    await waitFor(() => expect(row().getAttribute('aria-expanded')).toBe('true'));
  });

  it('a batch id that is not in the History opens nothing and breaks nothing', async () => {
    const { chat, first, second } = await twoBatches();
    openDiff(chat.id, { batchId: 'gone', path: 'src/a.ts' });
    const p = await waitFor(() => panel());
    await within(p).findByRole('region', { name: 'History' });
    for (const id of [first.id, second.id]) {
      expect(within(entry(p, id)).getByRole('button', { name: /a\.ts/ }).getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('a batchId without a path targets the batch but opens no file', async () => {
    const { chat, first } = await twoBatches();
    openDiff(chat.id, { batchId: first.id });
    const p = await waitFor(() => panel());
    await within(p).findByRole('region', { name: 'History' });
    expect(within(entry(p, first.id)).getByRole('button', { name: /a\.ts/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('with a pending proposal, a { batchId, path } request does not change the pending current file', async () => {
    const files = sampleProposal();
    const [a, b] = files as [(typeof files)[0], (typeof files)[0]];
    const pending: PendingChanges = {
      revision: 1,
      messageId: 'm9',
      files,
      totalAdd: 1,
      totalDel: 0,
    };
    const batch = autoBatch({ id: 'hb', written: [makeFileChange(a.path, 'modify', [makeHunk(1, 1, '', ['+HIST'])])] });
    const { chat } = await renderWithChanges({ pending, applied: [batch], diskSeq: 1 });
    openDiff(chat.id, { path: b.path });
    const p = await waitFor(() => panel());
    const nav = await within(p).findByRole('navigation', { name: 'Changed files' });
    await waitFor(() =>
      expect(
        within(nav)
          .getAllByRole('button')
          .find((x) => x.getAttribute('aria-current') === 'true')?.textContent,
      ).toContain(b.path.split('/').at(-1)),
    );
    openDiff(chat.id, { batchId: batch.id, path: a.path });
    await waitFor(() => expect(within(entry(p, batch.id)).getByText(/HIST/)).toBeTruthy());
    const current = within(nav)
      .getAllByRole('button')
      .find((x) => x.getAttribute('aria-current') === 'true');
    expect(current?.textContent).toContain(b.path.split('/').at(-1));
  });
});

describe('Diff panel: too_large', () => {
  const bigBatch = () =>
    autoBatch({
      written: [
        { ...makeFileChange('src/big.ts', 'modify', []), tooLarge: true },
        makeFileChange('src/small.ts', 'modify', [makeHunk(1, 1, '', ['-a', '+SMALL_CHANGE'])]),
      ],
    });

  it('shows "This diff is too large to show here." for a too-large file in the History, and the hunks of the others', async () => {
    const { chat } = await renderWithChanges({ pending: null, applied: [bigBatch()], diskSeq: 1 });
    openDiff(chat.id);
    const history = await within(panel()).findByRole('region', { name: 'History' });
    fireEvent.click(within(history).getByRole('button', { name: /big\.ts/ }));
    expect(within(history).getByText('This diff is too large to show here.')).toBeTruthy();
    fireEvent.click(within(history).getByRole('button', { name: /small\.ts/ }));
    expect(within(history).getByText(/SMALL_CHANGE/)).toBeTruthy();
    expect(within(history).getAllByText('This diff is too large to show here.')).toHaveLength(1);
  });

  it('also shows it when a card file row opens the too-large file', async () => {
    const batch = bigBatch();
    const { chat } = await renderWithChanges({ pending: null, applied: [batch], diskSeq: 1 });
    fireEvent.click(within(await autoCard()).getByRole('button', { name: /big\.ts/ }));
    const history = await within(await waitFor(() => panel())).findByRole('region', { name: 'History' });
    expect(await within(history).findByText('This diff is too large to show here.')).toBeTruthy();
    void chat;
  });
});
