import { Dialog, DialogContent } from '@renderer/components/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modalReturnFocus, useUiStore } from './ui';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
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
