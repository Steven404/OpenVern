import * as RadixDialog from '@radix-ui/react-dialog';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef, type ReactNode, type RefObject } from 'react';
import { Button } from './Button';
import { cx } from './cx';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
/** Closes the dialog; use `asChild` around a `Button`. */
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps extends Omit<ComponentPropsWithoutRef<typeof RadixDialog.Content>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned action row, typically `<Button>`s. */
  footer?: ReactNode;
  /** Max width in px (default 440). */
  width?: number;
  /**
   * Element to focus when the dialog closes. Needed when the dialog is opened from a menu item (the item unmounts,
   * so Radix has nothing to return to): pass a ref to the menu's trigger button. Without a `DialogTrigger` and
   * without this, focus falls to `<body>`.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Modal panel in a portal: backdrop, focus trap, Esc / backdrop click close, focus returns to the trigger. */
export const DialogContent = forwardRef<ElementRef<typeof RadixDialog.Content>, DialogContentProps>(
  function DialogContent(
    { title, description, footer, width = 440, returnFocusRef, onCloseAutoFocus, className, children, style, ...props },
    ref,
  ) {
    return (
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <RadixDialog.Content
          ref={ref}
          style={{ maxWidth: width, ...style }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (!returnFocusRef || event.defaultPrevented) return;
            const remembered = returnFocusRef.current;
            event.preventDefault();
            if (remembered?.isConnected) {
              remembered.focus();
              return;
            }
            // The remembered element unmounted. If another dialog is still open (a nested confirm closing back
            // into its parent), stay inside the top-most one; otherwise land on a stable spot instead of `<body>`.
            const openDialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
              (d) => d !== event.currentTarget,
            );
            const outer = openDialogs.at(-1);
            if (outer) {
              outer.focus();
              return;
            }
            const fallback =
              document.querySelector<HTMLElement>('textarea') ?? document.querySelector<HTMLElement>('main');
            if (fallback) {
              if (!fallback.matches('textarea') && !fallback.hasAttribute('tabindex')) fallback.tabIndex = -1;
              fallback.focus();
            }
          }}
          className={cx(
            'fixed top-1/2 left-1/2 z-50 flex outline-none max-h-[calc(100vh-32px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-[18px] border border-border-control bg-surface p-6 text-text shadow-2xl',
            className,
          )}
          {...props}
        >
          <div className="flex flex-col gap-1.5">
            <RadixDialog.Title className="font-display text-xl font-bold tracking-[-0.01em] text-text">
              {title}
            </RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="text-sm text-text-muted">{description}</RadixDialog.Description>
            ) : null}
          </div>
          {children}
          {footer ? <div className="mt-2 flex flex-wrap items-center justify-end gap-2">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    );
  },
);

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Default "Confirm". */
  confirmLabel?: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
  /** Spinner on the confirm button; both buttons are disabled. */
  loading?: boolean;
  /** Called on confirm; the dialog does NOT close itself (call `onOpenChange(false)` when done). */
  onConfirm: () => void;
  /** See `DialogContent.returnFocusRef`. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Optional body content between the description and the buttons (e.g. an inline error). */
  children?: ReactNode;
}

/** Controlled yes/no dialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  onConfirm,
  returnFocusRef,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        returnFocusRef={returnFocusRef}
        footer={
          <>
            <Button variant="ghost" disabled={loading} onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
