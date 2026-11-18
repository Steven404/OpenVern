import { IMAGE_ACCEPT, TEXT_ACCEPT } from '@shared/constants';
import type { AttachmentRef, Chat, ChatSummary, EditMode, Id, ReasoningEffort } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { patchChatSummary, useRunsStore } from '../../stores/runs';
import { useUiStore } from '../../stores/ui';
import { useTerminalUiStore } from '../terminal/terminal-store';
import { AttachMenu } from './AttachMenu';
import { ComposerAttachmentChips } from './AttachmentChips';
import { IMAGE_UNSUPPORTED_MESSAGE, registerAttachmentSink, useDraftAttachments } from './attachments';
import { EditModePicker } from './EditModePicker';
import { EffortPicker } from './EffortPicker';
import { ModelPicker } from './ModelPicker';
import { useModels, useProjects, useSettings } from './queries';
import { registerTextSink } from './text-sink';

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
  /** F3: reasoning effort for this composer; `null` = Default. */
  effort: ReasoningEffort | null;
  onEffortChange: (effort: ReasoningEffort | null) => void;
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
  /** Lets other features add uploaded files here through `addAttachmentRef(sinkKey, ref)` (reply: the chat id). */
  sinkKey?: string;
  /**
   * `new` variant: the edit mode the chat will be created with, and its setter. The reply variant reads and changes
   * the chat's own mode instead.
   */
  editMode?: EditMode;
  onEditModeChange?: (mode: EditMode) => void;
}

const HINT = 'Enter to send · Shift + Enter for a new line';
const TOOLS_NOTICE = "This model can't use tools, so it won't read your project files.";
const NO_KEY_NOTICE = 'Add your OpenRouter API key to start chatting.';
const EDIT_MODE_ERROR = "Couldn't change the edit mode. Try again.";
const EDIT_MODE_UNKNOWN = "Couldn't check this chat's edit mode, so sending is paused.";
/** The draft keeps a usable height even when the window is short and the terminal dock takes most of it. */
const COMPOSER_MIN_MAX_HEIGHT = 96;

/** How tall the growing draft may become: 40% of what the window has left after the terminal dock. */
export function composerMaxHeight(viewportHeight: number, dockHeight: number): number {
  return Math.max(COMPOSER_MIN_MAX_HEIGHT, Math.round((viewportHeight - dockHeight) * 0.4));
}

/** Shared reply / new-chat composer (D15, D16, D18): textarea, attach, model picker, send / stop, notices and hint. */
export function Composer({
  variant,
  model,
  onModelChange,
  effort,
  onEffortChange,
  projectId,
  running = false,
  busy = false,
  onStop,
  onSend,
  projectSlot,
  autoFocus,
  sinkKey,
  editMode: draftEditMode,
  onEditModeChange,
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
  // F3 follow-up: the picker only makes sense for a model that publishes the levels it accepts. Missing/empty
  // means no picker, and any stored effort behaves as Default.
  const efforts = info?.reasoningEfforts ?? [];
  const showEffortPicker = efforts.length > 0;
  const effectiveEffort = effort !== null && efforts.includes(effort) ? effort : null;
  const accept = supportsImages ? `${TEXT_ACCEPT},${IMAGE_ACCEPT}` : TEXT_ACCEPT;

  // Edit mode. A reply composer's `sinkKey` is its chat id (see `sinkKey`), so it reads the chat's stored mode from the
  // chat query the conversation already holds, and changes it with a PATCH. The New chat composer gets it from props.
  const chatId = variant === 'reply' ? sinkKey : undefined;
  const chatEditMode = useQuery({
    queryKey: queryKeys.chat(chatId ?? ''),
    queryFn: () => api.getChat(chatId ?? ''),
    enabled: chatId !== undefined,
    select: (chat: Chat) => chat.editMode,
  }).data;
  const modeSync = useChatEditModeSync(chatId);
  const editMode = chatId !== undefined ? chatEditMode : draftEditMode;
  const changeEditMode = (mode: EditMode) => {
    if (chatId !== undefined) modeSync.change(mode);
    else onEditModeChange?.(mode);
  };
  const project = useProjects().data?.find((p) => p.id === projectId);
  // Offered in a project chat, with a key, for a model known to use tools. Hidden otherwise; a stored Auto is kept
  // (the server still runs it) and shows again with a tools model.
  const showEditModePicker =
    projectId !== null && !noKey && info?.supportsTools === true && project !== undefined && editMode !== undefined;

  const [text, setText] = useState('');
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const attachments = useDraftAttachments(api, supportsImages);
  const { items, uploading, ready, addRef } = attachments;

  useEffect(() => (sinkKey ? registerAttachmentSink(sinkKey, addRef) : undefined), [sinkKey, addRef]);

  // A send or retry the server refused because the chat's edit mode changed: the chip now shows the server's mode
  // (the chat was fetched again), so say why nothing was sent and give back what was typed. Taken once, so a remount
  // (or React's double effect run in development) can't add the text twice. Nothing is resent.
  const refusal = useRunsStore((s) => (chatId !== undefined ? s.modeRefusals[chatId] : undefined));
  useEffect(() => {
    if (chatId === undefined || !refusal) return;
    const taken = useRunsStore.getState().takeModeRefusal(chatId);
    if (!taken) return;
    setSendError(taken.message);
    const unsent = taken.unsent;
    if (!unsent) return;
    setText((current) => (current.trim() === '' ? unsent.text : `${unsent.text}\n\n${current}`));
    for (const ref of unsent.attachments) addRef(ref);
  }, [chatId, refusal, addRef]);

  // An open terminal dock is fixed space under the composer: the draft grows into what is left of the column instead
  // of pushing the dock (and its prompt) below the window. `sinkKey` is the chat id for a reply composer and
  // `DRAFT_CHAT_ID` for the New Chat composer, the same keys the terminal dock store uses.
  const dockHeight = useTerminalUiStore((s) =>
    sinkKey !== undefined && s.openDocks[sinkKey] === true ? s.dockHeight : 0,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  // The text sink (terminal plan T3.5): "Add selection to chat" inserts a fenced block after whatever is typed, and the
  // caret goes to the composer so the user can ask about it.
  const insertText = useCallback((block: string) => {
    setText((previous) => (previous.trim() === '' ? block : `${previous.replace(/\s+$/, '')}\n\n${block}`));
    textareaRef.current?.focus();
  }, []);
  useEffect(() => (sinkKey ? registerTextSink(sinkKey, insertText) : undefined), [sinkKey, insertText]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // Auto-grow up to 40% of the viewport, less the dock when it is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the trigger; the height is read from the DOM
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = composerMaxHeight(window.innerHeight, dockHeight);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text, dockHeight]);

  const hasContent = text.trim().length > 0 || ready.length > 0;
  // INVARIANT: send is blocked while the mode is unconfirmed. Until the server has answered a mode change (or, after a
  // failed one, a fresh read has said which mode it kept), the chip may not show the mode the next turn would run in.
  const canSend = hasContent && !uploading && !noKey && !running && !busy && !sending && !modeSync.unconfirmed;

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

  // F3.4: `lastEffort` is remembered for new chats wherever `lastModel` is (picking an effort).
  const changeEffort = (next: ReasoningEffort | null) => {
    onEffortChange(next);
    api
      .updateSettings({ lastEffort: next })
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
  const hasNotices = imageNotice !== null || sendError !== null || modeSync.error !== null || noKey || showToolsNotice;

  return (
    <div className="flex flex-col" data-variant={variant}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={`flex flex-col bg-surface focus-within:bg-surface-focus transition-[background-color] duration-150 ${
          isNew
            ? 'gap-2.5 rounded-[14px] pt-4 pr-3.5 pb-2.5 pl-5 shadow-[0_16px_40px_-24px_rgb(0_0_0/0.35)]'
            : 'gap-2 rounded-[14px] pt-3.5 pr-3.5 pb-2.5 pl-[18px]'
        }`}
      >
        <ComposerAttachmentChips items={items} onRemove={attachments.remove} />
        <label htmlFor={inputId} className="sr-only">
          Message
        </label>
        <textarea
          id={inputId}
          ref={textareaRef}
          data-composer-input=""
          value={text}
          rows={isNew ? 3 : 2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isNew ? 'Ask a question, paste a snippet, or describe a task…' : 'Reply to OpenVern…'}
          className={`scrollbar-stable resize-none border-0 bg-transparent leading-normal text-text placeholder:text-text-faint focus-visible:outline-none ${
            isNew ? 'text-base' : 'text-[15.5px]'
          }`}
        />
        <div className="@container/toolbar flex flex-nowrap items-center gap-1.5 min-w-0">
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
          {showEditModePicker && (
            <EditModePicker
              value={editMode}
              onChange={changeEditMode}
              project={project}
              running={running || busy}
              pending={modeSync.pending}
            />
          )}
          {showEffortPicker && !noKey && (
            <EffortPicker
              value={effectiveEffort}
              efforts={efforts}
              defaultEffort={info?.defaultEffort}
              onChange={changeEffort}
            />
          )}
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
              className="inline-flex size-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-accent text-bg hover:brightness-106"
            >
              <Square aria-hidden="true" size={14} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send message"
              disabled={!canSend}
              className="inline-flex size-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-accent text-bg hover:brightness-106 disabled:cursor-not-allowed disabled:opacity-50"
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
          {modeSync.error && (
            <p role="alert" className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-danger">
              <span>{modeSync.error}</span>
              {modeSync.canRecheck && (
                <Button size="sm" onClick={modeSync.recheck}>
                  Try again
                </Button>
              )}
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

/**
 * `saving`: a mode PATCH is in flight. `confirming`: it failed and a fresh read of the chat is in flight. `unknown`:
 * that read failed too, so the cache can't be trusted to show the server's mode.
 */
type ModeSyncState = 'idle' | 'saving' | 'confirming' | 'unknown';

/**
 * Changes a chat's edit mode and keeps the chat caches in step with the server. One change at a time: the chip is
 * disabled while one is in flight, and a choice made anyway is dropped.
 */
function useChatEditModeSync(chatId: Id | undefined) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ModeSyncState>('idle');
  const [error, setError] = useState<string | null>(null);
  // The state is read synchronously too: two picks in one tick must not both start a PATCH.
  const inFlight = useRef(false);

  // INVARIANT: an older chat response must never overwrite a confirmed mode. A GET of the chat (or the chat list)
  // that started before the server took the new mode would write the old one back when it lands, so every such
  // request is cancelled before the cache is written. Cancelling reverts the query to its last settled data.
  const cancelChatReads = useCallback(
    (id: Id) =>
      Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.chat(id) }),
        queryClient.cancelQueries({ queryKey: queryKeys.chats }),
      ]),
    [queryClient],
  );

  /** After a failed PATCH: read the chat again, so the chip shows the mode the server kept. */
  const confirm = useCallback(
    async (id: Id) => {
      inFlight.current = true;
      setState('confirming');
      try {
        await cancelChatReads(id);
        // `staleTime: 0` always fetches; an in-flight read was cancelled above, so this one started after the PATCH.
        const { messages: _messages, ...summary } = await queryClient.fetchQuery({
          queryKey: queryKeys.chat(id),
          queryFn: () => api.getChat(id),
          staleTime: 0,
        });
        patchChatSummary(queryClient, summary);
        setState('idle');
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      } catch {
        // The cache may still hold the mode that was asked for, or the one before it: sending stays blocked.
        setError(EDIT_MODE_UNKNOWN);
        setState('unknown');
      } finally {
        inFlight.current = false;
      }
    },
    [api, queryClient, cancelChatReads],
  );

  const change = useCallback(
    async (mode: EditMode) => {
      if (chatId === undefined || inFlight.current) return;
      inFlight.current = true;
      setError(null);
      setState('saving');
      let summary: ChatSummary;
      try {
        await cancelChatReads(chatId);
        summary = await api.updateChat(chatId, { editMode: mode });
      } catch {
        inFlight.current = false;
        setError(EDIT_MODE_ERROR);
        await confirm(chatId);
        return;
      }
      // A read may have started while the PATCH was in flight and still hold the old mode: cancel it too.
      await cancelChatReads(chatId);
      patchChatSummary(queryClient, summary);
      inFlight.current = false;
      setState('idle');
      // Reconcile the rest of the chat. Any read from here on started after the server took the new mode.
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    },
    [api, chatId, queryClient, cancelChatReads, confirm],
  );

  const recheck = useCallback(() => {
    if (chatId === undefined || inFlight.current) return;
    setError(EDIT_MODE_ERROR);
    void confirm(chatId);
  }, [chatId, confirm]);

  return {
    change: (mode: EditMode) => void change(mode),
    recheck,
    error,
    /** The chip is busy: a change or its check is in flight. */
    pending: state === 'saving' || state === 'confirming',
    unconfirmed: state !== 'idle',
    canRecheck: state === 'unknown',
  };
}
