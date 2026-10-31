import { Button, Dialog, DialogContent, TextField } from '@renderer/components/ui';
import { ApiError } from '@renderer/lib/api-client';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';

export interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog heading, e.g. "Rename chat". */
  title: string;
  /** Input label, e.g. "Title". */
  label: string;
  initialValue: string;
  /** Called with the trimmed new value. A rejection is shown inline and keeps the dialog open. */
  onSubmit: (value: string) => Promise<unknown>;
  /** Pass the menu trigger when the dialog is opened from a menu item (see `DialogContent.returnFocusRef`). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Single-field rename dialog; the current value is selected on open. Used for chats and projects. */
export function RenameDialog({ open, onOpenChange, ...rest }: RenameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open so the field resets to `initialValue` each time. */}
      {open ? <RenameDialogBody onOpenChange={onOpenChange} {...rest} /> : null}
    </Dialog>
  );
}

function RenameDialogBody({
  onOpenChange,
  title,
  label,
  initialValue,
  onSubmit,
  returnFocusRef,
}: Omit<RenameDialogProps, 'open'>) {
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const mutation = useMutation({
    mutationFn: onSubmit,
    onSuccess: () => onOpenChange(false),
  });
  const trimmed = value.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || mutation.isPending) return;
    if (trimmed === initialValue) return onOpenChange(false);
    mutation.mutate(trimmed);
  };

  const error = mutation.error
    ? mutation.error instanceof ApiError
      ? mutation.error.info.message
      : 'Something went wrong. Try again.'
    : undefined;

  return (
    <DialogContent
      title={title}
      aria-describedby={undefined}
      width={420}
      returnFocusRef={returnFocusRef}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }}
      footer={
        <>
          <Button variant="ghost" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={mutation.isPending} disabled={!trimmed}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <TextField
          ref={inputRef}
          label={label}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (mutation.isError) mutation.reset();
          }}
          error={error}
          maxLength={200}
          autoComplete="off"
        />
      </form>
    </DialogContent>
  );
}
