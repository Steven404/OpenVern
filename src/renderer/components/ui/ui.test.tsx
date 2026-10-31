import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogTrigger,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  TextField,
} from './index';

// jsdom lacks a few browser APIs Radix relies on.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(cleanup);

describe('IconButton', () => {
  it('exposes its aria-label as the accessible name and tooltip as title', () => {
    render(
      <IconButton aria-label="Settings" tooltip="Open settings">
        <svg aria-hidden="true" />
      </IconButton>,
    );
    const btn = screen.getByRole('button', { name: 'Settings' });
    expect(btn.getAttribute('title')).toBe('Open settings');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('requires aria-label at the type level', () => {
    // @ts-expect-error aria-label is required
    const el = <IconButton>x</IconButton>;
    expect(el).toBeTruthy();
  });
});

describe('Button', () => {
  it('disables itself and shows a spinner while loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('spinner')).toBeTruthy();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards ref and click when idle', () => {
    const onClick = vi.fn();
    let el: HTMLButtonElement | null = null;
    render(
      <Button
        variant="primary"
        ref={(n) => {
          el = n;
        }}
        onClick={onClick}
      >
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(el).toBeInstanceOf(HTMLButtonElement);
    expect(screen.queryByTestId('spinner')).toBeNull();
  });
});

describe('TextField', () => {
  it('wires label, hint and error to the input', () => {
    render(<TextField label="Name" hint="Shown in the sidebar" error="Required" />);
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(['Required', 'Shown in the sidebar']);
  });

  it('has no aria-invalid / describedby without error or hint, and renders the trailing slot', () => {
    render(<TextField label="Key" trailing={<button type="button">Show</button>} />);
    const input = screen.getByLabelText('Key');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show' })).toBeTruthy();
  });
});

function DialogDemo() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open</Button>
      </DialogTrigger>
      <DialogContent title="Rename chat" description="Pick a title" footer={<Button>OK</Button>}>
        <TextField label="Title" />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDemo({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Delete?"
      danger
      confirmLabel="Delete"
      onConfirm={onConfirm}
    />
  );
}

function MenuDialogDemo() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton ref={triggerRef} aria-label="Options">
            …
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={() => setOpen(true)}>Rename</MenuItem>
        </MenuContent>
      </Menu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Rename" returnFocusRef={triggerRef} />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('opens, closes on Escape and returns focus to the trigger', async () => {
    render(<DialogDemo />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Rename chat' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('ConfirmDialog calls onConfirm and closes via Cancel', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDemo onConfirm={onConfirm} />);
    await screen.findByRole('dialog', { name: 'Delete?' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('Menu', () => {
  it('opens from the keyboard and selects an item with Enter', async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <Menu>
        <MenuTrigger asChild>
          <IconButton aria-label="Chat options">…</IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={onRename}>Rename</MenuItem>
          <MenuItem danger onSelect={onDelete}>
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>,
    );
    const trigger = screen.getByRole('button', { name: 'Chat options' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(menu.contains(document.activeElement)).toBe(true);
    // Keyboard-opened menus focus the first item; ArrowDown moves to the next.
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'Enter' });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('shows the current choice with a check in a radio group', async () => {
    render(
      <Menu>
        <MenuTrigger asChild>
          <Button>Move</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuRadioGroup value="b">
            <MenuRadioItem value="a">A</MenuRadioItem>
            <MenuRadioItem value="b">B</MenuRadioItem>
          </MenuRadioGroup>
        </MenuContent>
      </Menu>,
    );
    const trigger = screen.getByRole('button', { name: 'Move' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const b = await screen.findByRole('menuitemradio', { name: 'B' });
    expect(b.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'A' }).getAttribute('aria-checked')).toBe('false');
  });
});

describe('Menu to Dialog hand-off', () => {
  it('returns focus to the menu trigger after a dialog opened from a menu item closes', async () => {
    render(<MenuDialogDemo />);
    const trigger = screen.getByRole('button', { name: 'Options' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const item = await screen.findByRole('menuitem', { name: 'Rename' });
    fireEvent.keyDown(item, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog', { name: 'Rename' });
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
