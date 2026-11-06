import type { Id } from '@shared/types';
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Button, Spinner } from '../../components/ui';
import { selectRun, useRunsStore } from '../../stores/runs';
import { AppliedEditsCard, ProposedEditsCard } from '../changes';
import { useChat, useRunDeps } from '../composer/queries';
import { useChatChanges } from '../right-panel/queries';
import { AssistantTurn } from './AssistantTurn';
import { buildTurns, isWaiting, mergeMessages, turnHasMessage } from './turns';
import { UserBubble } from './UserBubble';

/** Pixels from the bottom within which the view keeps following new content. */
const STICK_THRESHOLD = 64;

export interface ConversationProps {
  chatId: Id;
}

/** The scrolling message list of a chat: persisted messages plus the in-flight run (S7.3 – S7.8). */
export function Conversation({ chatId }: ConversationProps) {
  const chatQuery = useChat(chatId);
  const run = useRunsStore(selectRun(chatId));
  const selectedModel = useRunsStore((s) => s.chatModels[chatId]);
  const selectedEffort = useRunsStore((s) => s.chatEfforts[chatId]);
  const deps = useRunDeps();
  const retryRun = useRunsStore((s) => s.retry);
  const changes = useChatChanges(chatId).data;

  const chat = chatQuery.data;
  const running = run?.status === 'running';
  const active = run?.status === 'running' || run?.status === 'settling';

  const messages = useMemo(() => mergeMessages(chat?.messages ?? [], run), [chat?.messages, run]);
  const turns = useMemo(
    () =>
      buildTurns(messages, {
        active: running,
        streamingId: run?.streamingId ?? null,
        runningToolIds: run?.runningToolIds ?? [],
      }),
    [messages, running, run?.streamingId, run?.runningToolIds],
  );
  const waiting = isWaiting(turns, run);

  const lastMessage = messages.at(-1);
  const lastAssistantErrored = lastMessage?.role === 'assistant' && lastMessage.status === 'error';
  const runError = run?.error && !lastAssistantErrored ? run.error : null;

  const retry = useCallback(() => {
    if (!chat) return;
    // F3: a retry uses the effort chosen in this chat; otherwise the chat keeps the effort it already stored.
    const model = selectedModel ?? chat.model;
    const picked = selectedEffort === undefined ? chat.effort : selectedEffort;
    void retryRun(deps, chatId, model, picked);
  }, [retryRun, deps, chatId, selectedModel, selectedEffort, chat]);

  // ── stick to bottom ────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
  };
  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);

  // A different chat, or a new run (the user just sent something): follow the bottom again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the triggers, not values read inside
  useLayoutEffect(() => {
    stick.current = true;
    toBottom();
  }, [chatId, run?.token, toBottom]);

  // Runs after every render, so streamed text and new rows keep the view pinned while the user is at the bottom.
  useLayoutEffect(toBottom);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(toBottom);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [toBottom]);

  const lastIndex = turns.length - 1;
  const hasContent = turns.length > 0;

  return (
    <section
      ref={scrollRef}
      onScroll={onScroll}
      aria-label="Conversation"
      aria-busy={active || undefined}
      className="min-h-0 flex-1 overflow-y-auto scrollbar-stable px-6 pt-10 pb-6"
    >
      <div ref={innerRef} className="mx-auto flex max-w-[760px] flex-col gap-8">
        {chatQuery.isPending && !run && (
          <div className="flex justify-center py-10 text-text-faint">
            <Spinner size={20} label="Loading conversation" />
          </div>
        )}
        {chatQuery.isError && !chat && (
          <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-text-muted">
            <p className="m-0">{chatQuery.error.message || "Couldn't load this conversation."}</p>
            <Button size="sm" onClick={() => void chatQuery.refetch()}>
              Try again
            </Button>
          </div>
        )}
        {chat && !hasContent && !run && (
          <p className="m-0 py-10 text-center text-[14px] text-text-faint">Send a message to get started.</p>
        )}

        {turns.map((turn, i) => {
          const isLast = i === lastIndex;
          const turnError = isLast ? runError : null;
          const turnWaiting = isLast && waiting;
          const turnStopped = isLast && !!run?.stopped;
          const pending = changes?.pending && turnHasMessage(turn, changes.pending.messageId) ? changes.pending : null;
          const batches = changes?.applied.filter((b) => turnHasMessage(turn, b.messageId)) ?? [];
          const cards =
            pending || batches.length > 0 ? (
              <>
                {batches.map((b) => (
                  <AppliedEditsCard key={b.id} chatId={chatId} batch={b} />
                ))}
                {pending && <ProposedEditsCard chatId={chatId} pending={pending} />}
              </>
            ) : undefined;
          const showAssistant = turn.blocks.length > 0 || !!turn.notice || turnWaiting || !!turnError || turnStopped;
          return (
            <Fragment key={turn.key}>
              {turn.user && <UserBubble message={turn.user} />}
              {showAssistant && (
                <AssistantTurn
                  blocks={turn.blocks}
                  notice={turn.notice}
                  waiting={turnWaiting}
                  footer={cards}
                  error={turnError}
                  forceRetry={!!run?.unsent}
                  stopped={turnStopped}
                  onRetry={isLast && !active ? retry : undefined}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
