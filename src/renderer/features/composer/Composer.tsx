import { IMAGE_ACCEPT, TEXT_ACCEPT } from '@shared/constants';
import type { AttachmentRef, Id } from '@shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Square } from 'lucide-react';
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '../../components/ui';
import { ApiError } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-context';
import { queryKeys } from '../../lib/query-keys';
import { useUiStore } from '../../stores/ui';
import { AttachMenu } from './AttachMenu';
import { ComposerAttachmentChips } from './AttachmentChips';
import { IMAGE_UNSUPPORTED_MESSAGE, useDraftAttachments } from './attachments';
import { ModelPicker } from './ModelPicker';
import { useModels, useSettings } from './queries';

export type ComposerVariant = 'reply' | 'new';

export interface ComposerSendInput {
  text: string;
  attachments: AttachmentRef[];
}

export interface ComposerProps {
  variant: ComposerVariant;
  /** Selected model id. */
  model: string;
  onModelChange: (id: string) => void;
  /** Project the message will belong to (drives the "can't use tools" notice). */
  projectId: Id | null;
  /** A stream is open: the send button becomes Stop. */
  running?: boolean;
  /** A run is active or settling: sending is blocked. */
  busy?: boolean;
  onStop?: () => void;
  /** Receives the message; may be async. If it rejects, the text and attachments come back with an error line. */
  onSend: (input: ComposerSendInput) => Promise<void> | void;
  /** `new` variant: the project chip, rendered in the toolbar after the attach button. */
  projectSlot?: ReactNode;
  autoFocus?: boolean;
}

const HINT = 'Enter to send · Shift + Enter for a new line';
const TOOLS_NOTICE = "This model can't use tools, so it won't read your project files.";
const NO_KEY_NOTICE = 'Add your OpenRouter API key to start chatting.';

/** Shared reply / new-chat composer (D15, D16, D18): textarea, attach, model picker, send / stop, notices and hint. */
export function Composer({
  variant,
  model,
  onModelChange,
  projectId,
  running = false,
  busy = false,
  onStop,
  onSend,
  projectSlot,
  autoFocus,
}: ComposerProps) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const openSettings = useUiStore((s) => s.openSettings);
  const settings = useSettings();
  const modelsQuery = useModels();

  const isNew = variant === 'new';
  const noKey =
    (settings.data ? !settings.data.openRouter.configured : false) ||
    (modelsQuery.error instanceof ApiError && modelsQuery.error.info.code === 'no_api_key');
  const info = modelsQuery.data?.find((m) => m.id === model);
  // Unknown capabilities (list not loaded yet): do not block; the server still validates.
  const supportsImages = info ? info.supportsImages : true;
  const supportsTools = info ? info.supportsTools : true;
  const accept = supportsImages ? `${TEXT_ACCEPT},${IMAGE_ACCEPT}` : TEXT_ACCEPT;

  const [text, setText] = useState('');
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const attachments = useDraftAttachments(api, supportsImages);
  const { items, uploading, ready } = attachments;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // Auto-grow up to 40% of the viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the trigger; the height is read from the DOM
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.4);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text]);

  const hasContent = text.trim().length > 0 || ready.length > 0;
  const canSend = hasContent && !uploading && !noKey && !running && !busy && !sending;

  const submit = useCallback(async () => {
    if (!canSend) return;
    setImageNotice(null);
    setSendError(null);
    // Last guard (S7.12): an image must never reach a model without image input.
    if (!supportsImages && ready.some((a) => a.isImage)) {
      attachments.removeImages();
      setImageNotice(IMAGE_UNSUPPORTED_MESSAGE);
      return;
    }
    const refs = ready.flatMap((a) => (a.ref ? [a.ref] : []));
    const draft = text;
    const taken = attachments.take();
    setText('');
    setSending(true);
    try {
      await onSend({ text: draft.trim(), attachments: refs });
    } catch (err) {
      setText(draft);
      attachments.restore(taken);
      setSendError(err instanceof Error && err.message ? err.message : "Couldn't send your message.");
    } finally {
      setSending(false);
    }
  }, [canSend, supportsImages, ready, attachments, text, onSend]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // No send while an IME is composing (keyCode 229 covers Safari's late compositionend).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  };

  const onFilesPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow picking the same file again
    if (files.length === 0) return;
    setImageNotice(null);
    setSendError(null);
    const { rejectedImages } = attachments.add(files);
    if (rejectedImages) setImageNotice(IMAGE_UNSUPPORTED_MESSAGE);
  };

  const changeModel = (id: string) => {
    setImageNotice(null);
    const next = modelsQuery.data?.find((m) => m.id === id);
    if (next && !next.supportsImages && attachments.removeImages() > 0) setImageNotice(IMAGE_UNSUPPORTED_MESSAGE);
    onModelChange(id);
    api
      .updateSettings({ lastModel: id })
      .then((s) => queryClient.setQueryData(queryKeys.settings, s))
      .catch(() => {});
  };

  const modelsError =
    modelsQuery.error && !noKey
      ? modelsQuery.error instanceof Error && modelsQuery.error.message
        ? modelsQuery.error.message
        : "Couldn't load models."
      : null;

  const showToolsNotice = projectId !== null && !supportsTools && !noKey;
  const hasNotices = imageNotice !== null || sendError !== null || noKey || showToolsNotice;

  return (
    <div className="flex flex-col" data-variant={variant}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={`flex flex-col border border-border-control bg-surface focus-within:border-border-focus ${
          isNew
            ? 'gap-2.5 rounded-[20px] pt-4 pr-3.5 pb-2.5 pl-5 shadow-[0_24px_64px_-32px_rgba(0,0,0,0.6)]'
            : 'gap-2 rounded-[18px] pt-3.5 pr-3.5 pb-2.5 pl-[18px]'
        }`}
      >
        <ComposerAttachmentChips items={items} onRemove={attachments.remove} />
        <label htmlFor={inputId} className="sr-only">
          Message
        </label>
        <textarea
          id={inputId}
          ref={textareaRef}
          value={text}
          rows={isNew ? 3 : 2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isNew ? 'Ask a question, paste a snippet, or describe a task…' : 'Reply to OpenVern…'}
          className={`resize-none border-0 bg-transparent leading-normal text-text outline-0 placeholder:text-text-faint focus-visible:outline-0 ${
            isNew ? 'text-base' : 'text-[15.5px]'
          }`}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <AttachMenu onAddFiles={() => fileInputRef.current?.click()} />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={accept}
            aria-label="Choose files"
            data-testid="file-input"
            onChange={onFilesPicked}
          />
          {projectSlot}
          <span className="flex-1" />
          <ModelPicker
            value={model}
            models={modelsQuery.data}
            loading={modelsQuery.isPending && modelsQuery.fetchStatus !== 'idle'}
            loadError={modelsError}
            noKey={noKey}
            onChange={changeModel}
            onAddKey={openSettings}
            onReload={() => void modelsQuery.refetch()}
          />
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={onStop}
              className="inline-flex size-[38px] cursor-pointer items-center justify-center rounded-[12px] border-0 bg-accent text-bg hover:brightness-110"
            >
              <Square aria-hidden="true" size={14} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send message"
              disabled={!canSend}
              className="inline-flex size-[38px] cursor-pointer items-center justify-center rounded-[12px] border-0 bg-accent text-bg hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowUp aria-hidden="true" size={18} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </form>

      {hasNotices && (
        <div className="mt-2.5 flex flex-col gap-1.5 text-[13px] leading-snug">
          {imageNotice && (
            <p role="alert" data-testid="image-notice" className="m-0 text-danger">
              {imageNotice}
            </p>
          )}
          {sendError && (
            <p role="alert" className="m-0 text-danger">
              {sendError}
            </p>
          )}
          {noKey && (
            <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-text-muted" data-testid="no-key-notice">
              <span>{NO_KEY_NOTICE}</span>
              <Button size="sm" onClick={openSettings}>
                Open settings
              </Button>
            </p>
          )}
          {showToolsNotice && (
            <p className="m-0 text-text-muted" data-testid="no-tools-notice">
              {TOOLS_NOTICE}
            </p>
          )}
        </div>
      )}

      <p
        className={
          isNew
            ? `m-0 text-center font-mono text-xs tracking-[0.06em] text-text-muted ${hasNotices ? 'mt-3' : 'mt-7'}`
            : 'm-0 mt-2 text-center text-xs text-text-faint'
        }
      >
        {HINT}
      </p>
    </div>
  );
}
