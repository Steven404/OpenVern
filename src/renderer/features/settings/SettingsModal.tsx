import { useSettings } from '@renderer/app/queries';
import { Button, ConfirmDialog, Dialog, DialogContent, IconButton, Spinner, TextField } from '@renderer/components/ui';
import { ApiError } from '@renderer/lib/api-client';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { modalReturnFocus, useUiStore } from '@renderer/stores/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';

export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

/**
 * Inline error copy for a failed "save key" or "remove key" call. Shows the error's own message (the server and
 * client already use the plan's copy), so a local "openvern server" failure is not blamed on OpenRouter.
 */
export function keyErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.info.message : 'Something went wrong. Try again.';
}

/** S6.7. Rendered once at the app level; driven by `useUiStore().settingsOpen`. */
export function SettingsModal() {
  const open = useUiStore((s) => s.settingsOpen);
  const close = useUiStore((s) => s.closeSettings);
  useSettings(); // loaded in the background so the modal opens with its content ready
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      {open ? (
        <DialogContent
          title="Settings"
          description="Connect OpenVern to a model provider."
          width={480}
          returnFocusRef={modalReturnFocus}
        >
          <OpenRouterSection />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function OpenRouterSection() {
  const settings = useSettings();
  const [replacing, setReplacing] = useState(false);

  let body: React.ReactNode;
  if (settings.isPending) {
    body = (
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <Spinner /> Loading…
      </div>
    );
  } else if (settings.isError) {
    body = (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-[13px] text-danger">
          Couldn't load settings.
        </p>
        <Button size="sm" onClick={() => settings.refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (settings.data.openRouter.configured && !replacing) {
    body = <ConnectedState keyHint={settings.data.openRouter.keyHint} onReplace={() => setReplacing(true)} />;
  } else {
    body = (
      <KeyForm
        onDone={() => setReplacing(false)}
        onCancel={settings.data.openRouter.configured ? () => setReplacing(false) : undefined}
      />
    );
  }

  return (
    <section aria-labelledby="settings-openrouter" className="flex flex-col gap-3">
      <h3 id="settings-openrouter" className="text-[15px] font-semibold text-text">
        OpenRouter
      </h3>
      {body}
    </section>
  );
}

function ConnectedState({ keyHint, onReplace }: { keyHint: string | null; onReplace: () => void }) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const removeRef = useRef<HTMLButtonElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.removeOpenRouterKey(),
    onSuccess: async (settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
      setConfirmOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.models }),
      ]);
    },
  });

  return (
    <>
      <div className="flex flex-col gap-3 rounded-[12px] border border-border-control bg-surface-raised px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />
          <p className="min-w-0 flex-1 truncate text-sm text-text">
            Connected · <span className="font-mono text-[13px] text-text-secondary">{keyHint}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onReplace}>
            Replace key
          </Button>
          <Button
            ref={removeRef}
            size="sm"
            onClick={() => {
              remove.reset();
              setConfirmOpen(true);
            }}
          >
            Remove key
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next) remove.reset();
          setConfirmOpen(next);
        }}
        title="Remove API key?"
        description="OpenVern can't chat until you add a key again."
        confirmLabel="Remove key"
        danger
        loading={remove.isPending}
        returnFocusRef={removeRef}
        onConfirm={() => remove.mutate()}
      >
        {remove.isError ? (
          <p role="alert" className="text-[13px] text-danger">
            {keyErrorMessage(remove.error)}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function KeyForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [visible, setVisible] = useState(false);
  // S6-M1: the key is handed to `mutationFn` through a ref (cleared on read) rather than as mutation `variables`,
  // so it never sits in the mutation cache; `gcTime: 0` also drops finished mutations once unobserved.
  // Mutations don't retry (default 0), so clearing on read can't resend an empty key.
  const keyRef = useRef('');

  const save = useMutation({
    gcTime: 0,
    mutationFn: () => {
      const key = keyRef.current;
      keyRef.current = '';
      return api.setOpenRouterKey(key);
    },
    onSuccess: async (settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
      onDone();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.models }),
      ]);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (key && !save.isPending) {
      keyRef.current = key;
      save.mutate();
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <TextField
        label="API key"
        type={visible ? 'text' : 'password'}
        value={apiKey}
        onChange={(event) => {
          setApiKey(event.target.value);
          if (save.isError) save.reset();
        }}
        placeholder="sk-or-v1-…"
        autoComplete="off"
        spellCheck={false}
        inputClassName="font-mono"
        error={save.isError ? keyErrorMessage(save.error) : undefined}
        hint={
          <>
            Get a key at{' '}
            <a
              href={OPENROUTER_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-text-secondary underline underline-offset-2 hover:text-text"
            >
              openrouter.ai/keys
            </a>
            . It is stored on this device.
          </>
        }
        trailing={
          <IconButton size="sm" aria-label="Show key" aria-pressed={visible} onClick={() => setVisible((v) => !v)}>
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
        }
      />
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" disabled={save.isPending} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" loading={save.isPending} disabled={apiKey.trim() === ''}>
          Save
        </Button>
      </div>
    </form>
  );
}
