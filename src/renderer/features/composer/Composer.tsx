import { IMAGE_ACCEPT, TEXT_ACCEPT } from '@shared/constants';
import type { AttachmentRef, EditMode, Id, ReasoningEffort } from '@shared/types';
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
import { ApiError, isProjectNotInGit } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-context';
import { queryKeys } from '../../lib/query-keys';
import {
  chatQueryOptions,
  confirmEditMode,
  EDIT_MODE_UNKNOWN,
  type ModeEntry,
  useEditModeEntry,
  writeChat,
} from '../../stores/edit-modes';
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
  /**
   * The edit mode the chip rendered when the user sent ('review' when the New chat chip is hidden). It is what the
   * turn is expected to run in, so it comes from this render, never from a cache read when the send fires.
   */
  editMode: EditMode;
  /** The project the composer showed (`projectId`), which the turn is expected to run in; `null` = no project. */
  projectId: Id | null;
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
   * `new` variant: the edit mode the chat will be created with, and its setter, which gets the project the pick was
   * decided for and whether that project's folder was shown as inside Git. The reply variant reads and changes the
   * chat's own mode instead.
   */
  editMode?: EditMode;
  onEditModeChange?: (mode: EditMode, projectId: Id, inGitRepo: boolean) => void;
  /**
   * `new` variant: the New chat opening the pick belongs to. A new value remounts the chip, so a no-Git warning opened
   * for an earlier opening (and its project) closes instead of being confirmed for this one.
   */
  editModeScope?: string;
}

const HINT = 'Enter to send · Shift + Enter for a new line';
const TOOLS_NOTICE = "This model can't use tools, so it won't read your project files.";
const NO_KEY_NOTICE = 'Add your OpenRouter API key to start chatting.';
/** A chat in Auto whose chip can't be shown (no project, or a model without tools): sending would run unseen Auto. */
export const AUTO_HIDDEN_NOTICE =
  "This chat is in Auto, which can't be shown here, so sending is paused. Move it into a project or pick a model that can use tools.";
/** The draft keeps a usable height even when the window is short and the terminal dock takes most of it. */
const COMPOSER_MIN_MAX_HEIGHT = 96;

/** How tall the growing draft may become: 40% of what the window has left after the terminal dock. */
export function composerMaxHeight(viewportHeight: number, dockHeight: number): number {
  return Math.max(COMPOSER_MIN_MAX_HEIGHT, Math.round((viewportHeight - dockHeight) * 0.4));
}

/**
 * The edit mode a composer shows, and whether a reply may be sent (or a turn retried) in it. Shared by the composer
 * and Retry, so both act on the same rendered value. `chatId` undefined = the New chat composer, whose mode is the
 * local `draft`.
 *
 * INVARIANT: in a chat that could edit (a project chat whose model isn't known to lack tools), a reply goes out only
 * with the chip on screen, and only while the chat's mode is `known`: never on a cold load before the chat was read,
 * and never while a mode change or its check is in flight. Auto goes out only with the chip on screen, in any chat: a
 * chat in Auto whose chip is hidden (no project, no key, a model without tools) can't send or retry (`autoHidden`),
 * because a move from another window could put it in a project where that unseen Auto writes.
 */
export function useReplyEditMode(chatId: Id | undefined, projectId: Id | null, model: string, draft?: EditMode) {
  const entry: ModeEntry = useEditModeEntry(chatId);
  const settings = useSettings();
  const modelsQuery = useModels();
  const project = useProjects().data?.find((p) => p.id === projectId);
  const mode = chatId !== undefined ? entry.mode : (draft ?? null);
  const noKey =
    (settings.data ? !settings.data.openRouter.configured : false) ||
    (modelsQuery.error instanceof ApiError && modelsQuery.error.info.code === 'no_api_key');
  const info = modelsQuery.data?.find((m) => m.id === model);
  // Unknown capabilities (the model list not loaded yet) count as tools: the chip shows, so the mode is on screen.
  const editCapable = projectId !== null && info?.supportsTools !== false;
  const showChip = editCapable && !noKey && project !== undefined && mode !== null;
  const known = entry.status === 'known' && entry.mode !== null;
  // Review may go out without the chip only where it couldn't show (the chat can't edit); Auto never does.
  const ready = known && (showChip || (!editCapable && entry.mode === 'review'));
  const autoHidden = chatId !== undefined && known && entry.mode === 'auto' && !editCapable;
  return { entry, mode, project, showChip, ready, noKey, autoHidden };
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
  editModeScope,
}: ComposerProps) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const openSettings = useUiStore((s) => s.openSettings);
  const modelsQuery = useModels();

  const isNew = variant === 'new';
  // Edit mode. A reply composer's `sinkKey` is its chat id (see `sinkKey`): its mode is the chat's shown mode
  // (`stores/edit-modes.ts`), changed with a PATCH. The New chat composer gets it from props.
  const chatId = variant === 'reply' ? sinkKey : undefined;
  // Subscribed so the chat is read (and its mode fed to the store) even where nothing else mounts the query; its data
  // is never read here.
  useQuery({ ...chatQueryOptions(api, chatId ?? ''), enabled: chatId !== undefined });
  const shown = useReplyEditMode(chatId, projectId, model, draftEditMode);
  const { entry, project, noKey } = shown;
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

  const editMode = shown.mode;
  const changeEditMode = (mode: EditMode, forProject: Id, inGitRepo: boolean) => {
    if (chatId === undefined) {
      onEditModeChange?.(mode, forProject, inGitRepo);
      return;
    }
    // Turning Auto on names the project whose no-Git warning was decided, and the Git status that decision rested on:
    // if the chat moved meanwhile, or its folder left Git, the server refuses instead of turning Auto on somewhere the
    // user wasn't warned about.
    writeChat({ api, queryClient }, chatId, 'mode', () =>
      api.updateChat(
        chatId,
        mode === 'auto'
          ? { editMode: 'auto', expectedProjectId: forProject, expectedInGitRepo: inGitRepo }
          : { editMode: mode },
      ),
    )
      .then((summary) => {
        if (summary) patchChatSummary(queryClient, summary);
      })
      .catch((err: unknown) => {
        // The store keeps the error for the notice below and checks the server's mode again. A folder that left Git
        // means the projects list is old: reading it again makes the next pick show the warning.
        if (isProjectNotInGit(err)) void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      });
  };
  const modePending = chatId !== undefined && (entry.status === 'saving' || entry.status === 'confirming');
  const modeUnknown = chatId !== undefined && entry.status === 'unknown';
  const modeNotice = modeUnknown
    ? EDIT_MODE_UNKNOWN
    : chatId !== undefined
      ? (entry.error ?? (shown.autoHidden && !noKey ? AUTO_HIDDEN_NOTICE : null))
      : null;
  const showEditModePicker = shown.showChip;

  const [text, setText] = useState('');
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const attachments = useDraftAttachments(api, supportsImages);
  const { items, uploading, ready, addRef } = attachments;

  useEffect(() => (sinkKey ? registerAttachmentSink(sinkKey, addRef) : undefined), [sinkKey, addRef]);

  // A send or retry the server refused because the chat's edit mode changed: the chip is catching up with the server's
  // mode (the runs store checks it again, and sending waits for that), so say why nothing was sent and give back what was typed. Taken once, so a remount
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
  // INVARIANT: a reply is sent only in a mode that is on screen and confirmed (see `useReplyEditMode`). Until the chat
  // was read, while a mode change or its check is in flight, or after that check failed, the chip may not show the
  // mode the next turn would run in.
  const canSend = hasContent && !uploading && !noKey && !running && !busy && !sending && (isNew || shown.ready);
  // What the turn is expected to run in: the value this render shows.
  const sendMode: EditMode = isNew
    ? shown.showChip && editMode !== null
      ? editMode
      : 'review'
    : (entry.mode ?? 'review');

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
      await onSend({ text: draft.trim(), attachments: refs, editMode: sendMode, projectId });
    } catch (err) {
      setText(draft);
      attachments.restore(taken);
      setSendError(err instanceof Error && err.message ? err.message : "Couldn't send your message.");
    } finally {
      setSending(false);
    }
  }, [canSend, supportsImages, ready, attachments, text, onSend, sendMode, projectId]);

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
  const hasNotices = imageNotice !== null || sendError !== null || modeNotice !== null || noKey || showToolsNotice;

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
          {showEditModePicker && editMode !== null && project !== undefined && (
            <EditModePicker
              key={editModeScope}
              value={editMode}
              onChange={changeEditMode}
              project={project}
              running={running || busy}
              pending={modePending}
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
          {modeNotice && (
            <p role="alert" className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-danger">
              <span>{modeNotice}</span>
              {modeUnknown && chatId !== undefined && (
                <Button size="sm" onClick={() => void confirmEditMode({ api, queryClient }, chatId)}>
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
