import { Dialog, DialogContent } from '@renderer/components/ui';
import { LIST_RATIO_DEFAULT } from '@shared/constants';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { modalReturnFocus, readPersistedUi, STORAGE_KEYS, useUiStore } from './ui';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  modalReturnFocus.current = null;
  useUiStore.setState({ newProjectOpen: false });
});

function Harness({ withMenu }: { withMenu: boolean }) {
  const open = useUiStore((s) => s.newProjectOpen);
  return (
    <>
      <main>
        <textarea aria-label="Message" />
        <button type="button" id="chip" aria-controls="chip-menu">
          Project
        </button>
        {withMenu ? (
          <div role="menu" id="chip-menu">
            <button type="button" role="menuitem">
              Add project…
            </button>
          </div>
        ) : null}
      </main>
      <Dialog open={open} onOpenChange={(o) => !o && useUiStore.getState().closeNewProject()}>
        <DialogContent title="New project" returnFocusRef={modalReturnFocus} />
      </Dialog>
    </>
  );
}

function Nested({ withTrigger, innerOpen }: { withTrigger: boolean; innerOpen: boolean }) {
  return (
    <>
      <main>
        <textarea aria-label="Message" />
      </main>
      <Dialog open>
        <DialogContent title="Settings">
          {withTrigger ? (
            <button type="button" id="remove">
              Remove key
            </button>
          ) : (
            <p>Not connected</p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={innerOpen}>
        <DialogContent title="Remove key?" returnFocusRef={modalReturnFocus} />
      </Dialog>
    </>
  );
}

async function closeDialog() {
  const dialog = await screen.findByRole('dialog', { name: 'New project' });
  await act(async () => {
    fireEvent.keyDown(dialog, { key: 'Escape' });
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('diff list ratio (global, persisted)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ diffListRatio: LIST_RATIO_DEFAULT });
  });

  it('defaults to 0.35 when nothing is stored', () => {
    expect(readPersistedUi().diffListRatio).toBe(0.35);
    expect(useUiStore.getState().diffListRatio).toBe(0.35);
  });

  it('reads a stored fraction', () => {
    window.localStorage.setItem(STORAGE_KEYS.diffListRatio, '0.5');
    expect(readPersistedUi().diffListRatio).toBe(0.5);
  });

  it('falls back to the default for a corrupt value and keeps an out-of-range one within [0, 1]', () => {
    window.localStorage.setItem(STORAGE_KEYS.diffListRatio, 'garbage');
    expect(readPersistedUi().diffListRatio).toBe(0.35);
    window.localStorage.setItem(STORAGE_KEYS.diffListRatio, 'Infinity');
    expect(readPersistedUi().diffListRatio).toBe(0.35);
    window.localStorage.setItem(STORAGE_KEYS.diffListRatio, '5');
    expect(readPersistedUi().diffListRatio).toBe(1);
    window.localStorage.setItem(STORAGE_KEYS.diffListRatio, '-2');
    expect(readPersistedUi().diffListRatio).toBe(0);
  });

  it('keeps a value the store cannot judge against the body, so a small window does not rewrite it', () => {
    // 0.8 is too tall for a 400px body; the Diff surface clamps what it shows, the stored preference stays 0.8.
    window.localStorage.setItem(STORAGE_KEYS.diffListRatio, '0.8');
    expect(readPersistedUi().diffListRatio).toBe(0.8);
  });

  it('writes storage on set by default, but not with persist: false until commit', () => {
    useUiStore.getState().setDiffListRatio(0.4, { persist: false });
    expect(useUiStore.getState().diffListRatio).toBe(0.4);
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBeNull();

    useUiStore.getState().commitDiffListRatio();
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBe('0.4');

    useUiStore.getState().setDiffListRatio(0.6);
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBe('0.6');
  });

  it('sanitizes a set value to [0, 1] before it is stored', () => {
    useUiStore.getState().setDiffListRatio(5);
    expect(useUiStore.getState().diffListRatio).toBe(1);
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBe('1');
  });
});

describe('app-level modal focus return', () => {
  it('returns focus to the menu trigger when opened from a menu item that then unmounts', async () => {
    const { rerender } = render(<Harness withMenu />);
    screen.getByRole('menuitem').focus();
    act(() => useUiStore.getState().openNewProject());
    rerender(<Harness withMenu={false} />);
    await closeDialog();
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('chip')));
  });

  it('falls back to the composer when the remembered element is gone', async () => {
    const { rerender } = render(<Harness withMenu />);
    // Not inside a menu with a known trigger: remembered element is the item itself.
    screen.getByRole('menuitem').removeAttribute('role');
    document.getElementById('chip-menu')?.removeAttribute('role');
    (screen.getByText('Add project…') as HTMLElement).focus();
    act(() => useUiStore.getState().openNewProject());
    rerender(<Harness withMenu={false} />);
    await closeDialog();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Message')));
  });

  it("keeps focus inside a still-open outer dialog when the nested dialog's trigger is gone", async () => {
    const { rerender } = render(<Nested withTrigger innerOpen={false} />);
    const remove = document.getElementById('remove') as HTMLElement;
    remove.focus();
    modalReturnFocus.current = remove;
    rerender(<Nested withTrigger innerOpen />);
    await screen.findByRole('dialog', { name: 'Remove key?' });
    // Confirming removes the trigger, then the confirm closes.
    rerender(<Nested withTrigger={false} innerOpen />);
    await act(async () => rerender(<Nested withTrigger={false} innerOpen={false} />));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove key?' })).toBeNull());
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    await waitFor(() => expect(settings.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(screen.getByLabelText('Message'));
  });
});

describe('Auto: no-Git acknowledgment (per project, persisted)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ autoNoGitAcknowledged: {} });
  });

  it('starts empty when nothing is stored', () => {
    expect(readPersistedUi().autoNoGitAcknowledged).toEqual({});
  });

  it('records a project, writes the JSON id list, and survives a reload', () => {
    useUiStore.getState().acknowledgeAutoNoGit('p1');
    useUiStore.getState().acknowledgeAutoNoGit('p2');
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({ p1: true, p2: true });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.autoNoGitAcknowledged) ?? 'null')).toEqual(['p1', 'p2']);
    // A reload: the store state is rebuilt from storage.
    expect(readPersistedUi().autoNoGitAcknowledged).toEqual({ p1: true, p2: true });
  });

  it('acknowledging a project twice writes nothing the second time', () => {
    useUiStore.getState().acknowledgeAutoNoGit('p1');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    useUiStore.getState().acknowledgeAutoNoGit('p1');
    expect(set).not.toHaveBeenCalled();
    expect(Object.keys(useUiStore.getState().autoNoGitAcknowledged)).toEqual(['p1']);
  });

  it('ignores a corrupt or wrongly shaped stored value', () => {
    for (const bad of ['{not json', '{"p1":true}', '"p1"', '42', 'null']) {
      window.localStorage.setItem(STORAGE_KEYS.autoNoGitAcknowledged, bad);
      expect(readPersistedUi().autoNoGitAcknowledged).toEqual({});
    }
    window.localStorage.setItem(STORAGE_KEYS.autoNoGitAcknowledged, JSON.stringify(['p1', 7, null, 'p2']));
    expect(readPersistedUi().autoNoGitAcknowledged).toEqual({ p1: true, p2: true });
  });

  it('survives unavailable storage: reads give an empty set, a write is kept in memory only', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => readPersistedUi()).not.toThrow();
    expect(readPersistedUi().autoNoGitAcknowledged).toEqual({});
    expect(() => useUiStore.getState().acknowledgeAutoNoGit('p1')).not.toThrow();
    expect(set).toHaveBeenCalled();
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({ p1: true });
  });

  it('survives a storage quota error on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => useUiStore.getState().acknowledgeAutoNoGit('p1')).not.toThrow();
    expect(useUiStore.getState().autoNoGitAcknowledged).toEqual({ p1: true });
  });
});
