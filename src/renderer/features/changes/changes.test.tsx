import { renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { ApiError } from '@renderer/lib/api-client';
import { makeFileChange, makeHunk, sampleProposal } from '@renderer/lib/mock-changes';
import { queryKeys } from '@renderer/lib/query-keys';
import { createRun, useRunsStore } from '@renderer/stores/runs';
import { useUiStore } from '@renderer/stores/ui';
import { LAYOUT } from '@shared/constants';
import { errorInfo } from '@shared/errors';
import type { PendingChanges } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanelStore } from '../right-panel/panel-store';
import {
  allRejected,
  appliedLabel,
  buildDecisions,
  fileState,
  footerHint,
  pairLines,
  parseHunk,
  progressLabel,
  progressOf,
} from './diff';
import { effectiveDecisions, useReviewStore } from './review-store';

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

const pendingOf = (revision = 1): PendingChanges => {
  const files = sampleProposal();
  return {
    revision,
    messageId: 'm1',
    files,
    totalAdd: files.reduce((n, f) => n + f.add, 0),
    totalDel: files.reduce((n, f) => n + f.del, 0),
  };
};

describe('diff helpers', () => {
  it('numbers lines and pairs deletions with additions', () => {
    const h = makeHunk(10, 12, '', [' a', '-b', '-c', '+B', '+C', '+D', ' e']);
    const lines = parseHunk(h);
    expect(lines.map((l) => [l.o, l.n])).toEqual([
      [10, 12],
      [11, null],
      [12, null],
      [null, 13],
      [null, 14],
      [null, 15],
      [13, 16],
    ]);
    const rows = pairLines(lines);
    expect(rows).toHaveLength(5);
    expect(rows[3]?.left).toBeNull();
    expect(rows[3]?.right?.code).toBe('D');
    expect(rows[0]?.left).toBe(rows[0]?.right);
  });

  it('labels progress, hints and file state', () => {
    const p = pendingOf();
    const [create, index] = p.files as [(typeof p.files)[0], (typeof p.files)[0]];
    expect(progressLabel(progressOf(p.files, {}))).toBe('0 of 4 changes reviewed');
    expect(footerHint(progressOf(p.files, {}))).toBe('Undecided changes are left out when you apply.');

    const all = (d: 'accepted' | 'rejected') =>
      Object.fromEntries(p.files.map((f) => [f.path, Object.fromEntries(f.hunks.map((h) => [h.id, d]))]));
    expect(progressLabel(progressOf(p.files, all('accepted')))).toBe('All 4 changes reviewed');
    expect(footerHint(progressOf(p.files, all('accepted')))).toBe('Ready to write to disk.');
    expect(footerHint(progressOf(p.files, all('rejected')))).toBe('4 rejected changes will be dropped.');
    expect(allRejected(progressOf(p.files, all('rejected')))).toBe(true);

    const first = index.hunks[0]?.id as string;
    expect(fileState(index, { [first]: 'accepted' })).toEqual({ label: '1 of 2', tone: 'neutral' });
    expect(fileState(index, { [first]: 'accepted', [index.hunks[1]?.id as string]: 'rejected' }).label).toBe(
      'Partly accepted',
    );
    expect(fileState(create, { [create.hunks[0]?.id as string]: 'rejected' })).toEqual({
      label: 'Rejected',
      tone: 'bad',
    });
  });

  it('describes an applied batch', () => {
    const files = sampleProposal();
    expect(
      appliedLabel({
        id: 'b',
        appliedAt: '2026-01-01T00:00:00.000Z',
        messageId: 'm1',
        written: files,
        rejectedHunks: 1,
        skippedHunks: 0,
        conflicts: [],
      }),
    ).toBe('Wrote 4 changes to 3 files · 1 rejected');
  });
});

describe('decisions store', () => {
  it('keeps decisions for hunk ids that still exist when the revision changes', () => {
    const rev1 = pendingOf(1);
    const store = useReviewStore.getState();
    const [create, index] = rev1.files as [(typeof rev1.files)[0], (typeof rev1.files)[0]];
    store.decide('c', rev1, create.path, create.hunks[0]?.id as string, 'accepted');
    store.decide('c', rev1, index.path, index.hunks[1]?.id as string, 'rejected');

    // Revision 2: the index.ts second hunk changed (new id), the rest is the same.
    const changed = makeFileChange(index.path, 'modify', [
      index.hunks[0] as (typeof index.hunks)[0],
      makeHunk(21, 22, '', [' x', '-y', '+z']),
    ]);
    const rev2: PendingChanges = { ...rev1, revision: 2, files: [create, changed] };
    const eff = effectiveDecisions(useReviewStore.getState().chats.c, rev2);
    expect(eff[create.path]).toEqual({ [create.hunks[0]?.id as string]: 'accepted' });
    expect(eff[index.path]).toBeUndefined();
    expect(buildDecisions(rev2.files, eff)).toEqual(eff);
  });

  it('Accept all / Reject all / Undo', () => {
    const p = pendingOf();
    const s = useReviewStore.getState();
    s.setAll('c', p, 'accepted');
    expect(progressOf(p.files, effectiveDecisions(useReviewStore.getState().chats.c, p)).accepted).toBe(4);
    s.setAll('c', p, 'rejected');
    expect(progressOf(p.files, effectiveDecisions(useReviewStore.getState().chats.c, p)).rejected).toBe(4);
    const f = p.files[0] as (typeof p.files)[0];
    s.decide('c', p, f.path, f.hunks[0]?.id as string, null);
    expect(progressOf(p.files, effectiveDecisions(useReviewStore.getState().chats.c, p)).rejected).toBe(3);
  });
});

async function stagedChat() {
  const seed = await seededClient();
  const { client, chat } = seed;
  for await (const _ev of client.sendMessage(
    chat.id,
    { text: '[mock:edit]', attachmentIds: [], model: chat.model },
    new AbortController().signal,
  )) {
    // drain: stages the sample proposal and persists the turn
  }
  return seed;
}

async function renderStaged() {
  const seed = await stagedChat();
  renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
  await screen.findByRole('heading', { level: 1, name: seed.chat.title });
  return seed;
}

const panel = () => screen.getByRole('complementary', { name: 'Right panel' });
const card = async () => screen.findByTestId('changes-card');

describe('proposed edits card', () => {
  it('sits under the turn of PendingChanges.messageId and lists the files', async () => {
    const { client, chat } = await renderStaged();
    const el = await card();
    expect(within(el).getByText('Proposed edits')).toBeTruthy();
    expect(within(el).getByText('3 files')).toBeTruthy();
    expect(within(el).getByText('0 of 4 changes reviewed')).toBeTruthy();
    expect(within(el).getByText('Nothing is written until you apply.')).toBeTruthy();
    const turn = el.closest('[data-testid="assistant-turn"]');
    expect(turn).toBeTruthy();
    const pending = (await client.getChatChanges(chat.id)).pending;
    expect(pending?.messageId).toBeTruthy();
    expect(screen.getAllByTestId('changes-card')).toHaveLength(1);
  });

  it('opens the pane on the clicked file', async () => {
    await renderStaged();
    const el = await card();
    fireEvent.click(within(el).getByRole('button', { name: /constants\.ts/ }));
    const p = await waitFor(() => panel());
    expect(within(p).getByRole('region', { name: 'Review changes' })).toBeTruthy();
    expect(
      within(p)
        .getByRole('button', { name: /constants\.ts/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    expect(within(p).getByText('1 change')).toBeTruthy();
    expect(within(el).getByRole('button', { name: /Reviewing/ })).toBeTruthy();
  });
});

describe('review pane', () => {
  async function openReview() {
    const seed = await renderStaged();
    fireEvent.click(within(await card()).getByRole('button', { name: /Review changes/ }));
    const p = await waitFor(() => panel());
    await within(p).findByRole('button', { name: 'Apply' });
    return { ...seed, p };
  }

  it('decides hunks, shows labels and applies the accepted ones', async () => {
    const { client, chat, p } = await openReview();
    const spy = vi.spyOn(client, 'applyChatChanges');

    expect((within(p).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(p).getByRole('button', { name: 'Accept all' }));
    expect(within(p).getByText('All 4 changes reviewed')).toBeTruthy();
    expect(within(p).getByText('Ready to write to disk.')).toBeTruthy();
    expect(within(p).getAllByText('Accepted').length).toBeGreaterThan(0);

    // Undo and reject the single hunk of the first file (write-file.ts, selected by default).
    fireEvent.click(within(p).getByRole('button', { name: 'Undo decision' }));
    expect(within(p).getByText('3 of 4 changes reviewed')).toBeTruthy();
    fireEvent.click(within(p).getByRole('button', { name: 'Reject this change' }));
    expect(within(p).getByText('All 4 changes reviewed')).toBeTruthy();
    expect(within(p).getByText('1 rejected change will be dropped.')).toBeTruthy();

    fireEvent.click(within(p).getByRole('button', { name: 'Apply 3' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [, body] = spy.mock.calls[0] as [
      string,
      { revision: number; decisions: Record<string, Record<string, string>> },
    ];
    expect(Object.keys(body.decisions)).toHaveLength(3);
    expect(Object.values(body.decisions['src/core/tools/write-file.ts'] ?? {})).toEqual(['rejected']);
    expect(Object.values(body.decisions['src/core/tools/index.ts'] ?? {})).toEqual(['accepted', 'accepted']);

    const cardEl = await screen.findByText('Edits applied');
    const shell = cardEl.closest('[data-testid="changes-card"]') as HTMLElement;
    expect(within(shell).getByText('Wrote 3 changes to 2 files · 1 rejected')).toBeTruthy();
    expect((await client.getChatChanges(chat.id)).pending).toBeNull();
    // Applied batches stay listed, read-only, and Diff stays enabled.
    expect(await within(panel()).findByTestId('applied-batch')).toBeTruthy();
  });

  it('shows "Discard" when every change is rejected and clears the proposal', async () => {
    const { client, chat, p } = await openReview();
    const spy = vi.spyOn(client, 'discardChatChanges');
    fireEvent.click(within(p).getByRole('button', { name: 'Reject all' }));
    fireEvent.click(within(p).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(chat.id));
    await waitFor(() => expect(within(panel()).getByText('No edits are waiting for review.')).toBeTruthy());
  });

  it('refetches on changes_stale and keeps decisions for surviving hunk ids', async () => {
    const { client, chat, p } = await openReview();
    const current = await client.getChatChanges(chat.id);
    const pending = current.pending as PendingChanges;
    fireEvent.click(within(p).getByRole('button', { name: 'Accept all' }));

    const next: PendingChanges = {
      ...pending,
      revision: pending.revision + 1,
      files: pending.files.filter((f) => !f.path.endsWith('constants.ts')),
    };
    vi.spyOn(client, 'applyChatChanges').mockRejectedValue(new ApiError(errorInfo('changes_stale'), 409));
    const get = vi.spyOn(client, 'getChatChanges').mockResolvedValue({ pending: next, applied: [] });

    fireEvent.click(within(p).getByRole('button', { name: /Apply 4/ }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(
      await within(p).findByText('The proposed edits changed while you were reviewing. Review them again.'),
    ).toBeTruthy();
    // The constants.ts hunk is gone; the other three keep their decision.
    expect(await within(p).findByText('All 3 changes reviewed')).toBeTruthy();
    expect(within(p).getByRole('button', { name: 'Apply 3' })).toBeTruthy();
  });

  it('shows other apply errors inline', async () => {
    const { client, p } = await openReview();
    fireEvent.click(within(p).getByRole('button', { name: 'Accept all' }));
    vi.spyOn(client, 'applyChatChanges').mockRejectedValue(
      new ApiError(errorInfo('conflict', 'Wait for the reply to finish first.'), 409),
    );
    fireEvent.click(within(p).getByRole('button', { name: /Apply 4/ }));
    expect(await within(p).findByText('Wait for the reply to finish first.')).toBeTruthy();
  });

  it('disables Apply and Discard while the chat is streaming', async () => {
    const { chat, p } = await openReview();
    fireEvent.click(within(p).getByRole('button', { name: 'Accept all' }));
    expect((within(p).getByRole('button', { name: /Apply 4/ }) as HTMLButtonElement).disabled).toBe(false);
    useRunsStore.setState({ runs: { [chat.id]: createRun(1) } });
    await waitFor(() =>
      expect((within(p).getByRole('button', { name: /Apply 4/ }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(within(p).getByText('Wait for the reply to finish.')).toBeTruthy();
    fireEvent.click(within(p).getByRole('button', { name: 'Reject all' }));
    expect((within(p).getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(true);
  });

  const panelWidthNow = () => useUiStore.getState().rightPanelWidth;
  const splitBtn = (p: HTMLElement) => within(p).getByRole('button', { name: 'Split' }) as HTMLButtonElement;

  it('switches to the split layout when there is room, widening the panel', async () => {
    const { p } = await openReview();
    const split = splitBtn(p);
    expect(split.disabled).toBe(false);
    expect(panelWidthNow()).toBe(380);
    fireEvent.click(split);
    expect(panelWidthNow()).toBe(LAYOUT.panelDiffSplit);
    expect(p.style.width).toBe('800px');
    expect(split.getAttribute('aria-pressed')).toBe('true');
    expect(p.querySelector('[data-side="left"]')).toBeTruthy();
    expect(p.querySelector('[data-line="none"]')).toBeTruthy();
  });

  it('keeps an already wide panel as is when Split is picked', async () => {
    act(() => useUiStore.getState().setRightPanelWidth(700));
    const { p } = await openReview();
    fireEvent.click(splitBtn(p));
    expect(panelWidthNow()).toBe(700);
    expect(splitBtn(p).getAttribute('aria-pressed')).toBe('true');
    expect(p.querySelector('[data-side="left"]')).toBeTruthy();
  });

  it('widens only as far as the window allows', async () => {
    window.innerWidth = 1400;
    const { p } = await openReview();
    fireEvent.click(splitBtn(p));
    expect(panelWidthNow()).toBe(708);
    expect(p.querySelector('[data-side="left"]')).toBeTruthy();
  });

  it('falls back to unified when the panel is narrowed, and Split widens it again', async () => {
    const { p } = await openReview();
    fireEvent.click(splitBtn(p));
    act(() => useUiStore.getState().setRightPanelWidth(500));
    expect(splitBtn(p).getAttribute('aria-pressed')).toBe('false');
    expect(within(p).getByRole('button', { name: 'Unified' }).getAttribute('aria-pressed')).toBe('true');
    expect(p.querySelector('[data-side="left"]')).toBeNull();
    expect(splitBtn(p).disabled).toBe(false);
    fireEvent.click(splitBtn(p));
    expect(panelWidthNow()).toBe(LAYOUT.panelDiffSplit);
    expect(p.querySelector('[data-side="left"]')).toBeTruthy();
  });

  it('disables Split on a narrow window', async () => {
    window.innerWidth = 1100;
    const { p } = await openReview();
    const split = splitBtn(p);
    expect(split.disabled).toBe(true);
    expect(split.title).toBe('Make the window wider to use Split');
    fireEvent.click(split);
    expect(panelWidthNow()).toBe(380);
  });

  it('enables Split on a narrow window when the sidebar is collapsed', async () => {
    window.innerWidth = 1100;
    useUiStore.setState({ sidebarCollapsed: true });
    const { p } = await openReview();
    expect(splitBtn(p).disabled).toBe(false);
    fireEvent.click(splitBtn(p));
    expect(panelWidthNow()).toBe(680);
  });

  it('marks the placeholder for a file that is too large', async () => {
    const { client, chat } = await openReview();
    const current = (await client.getChatChanges(chat.id)).pending as PendingChanges;
    const big = { ...current.files[0], tooLarge: true, hunks: [] } as PendingChanges['files'][number];
    cleanup();
    vi.spyOn(client, 'getChatChanges').mockResolvedValue({
      pending: { ...current, files: [big, ...current.files.slice(1)] },
      applied: [],
    });
    renderApp({ client, route: `/chat/${chat.id}` });
    // The panel is still open on the Diff tab.
    expect(await screen.findByText(/too large to show here/)).toBeTruthy();
  });
});

describe('live updates', () => {
  it('changes_updated refreshes the chatChanges query during the run', async () => {
    const { client, chat } = await seededClient();
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.chatChanges(chat.id), { pending: null, applied: [] });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await useRunsStore
      .getState()
      .send({ api: client, queryClient }, chat.id, { text: '[mock:edit]', attachments: [], model: chat.model });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.chatChanges(chat.id) });
    expect((await client.getChatChanges(chat.id)).pending?.files).toHaveLength(3);
  });
});
