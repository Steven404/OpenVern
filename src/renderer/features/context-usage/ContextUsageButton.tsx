// F1: the context counter in the chat header (plan §5.1). Hidden until the chat has a finished request, then
// reads `used / limit`; clicking it opens the Context popover. The figures come from `chat.usage`, which the
// trailing `chat_updated` of a run patches into the cached summary, so they change when a reply finishes.

import { cx } from '@renderer/components/ui';
import { modelName } from '@renderer/features/composer/models';
import { useModels } from '@renderer/features/composer/queries';
import { useRunsStore } from '@renderer/stores/runs';
import type { ChatSummary, ChatUsage } from '@shared/types';
import { useRef } from 'react';
import { ContextUsagePopover } from './ContextUsagePopover';
import { contextView } from './format';

/** Last idle usage per chat, so a remount during a run still has the pre-run figures. */
const idleUsageByChat = new Map<string, ChatUsage>();

export function ContextUsageButton({ chat }: { chat: ChatSummary }) {
  const models = useModels();
  const active = useRunsStore((s) => {
    const status = s.runs[chat.id]?.status;
    return status === 'running' || status === 'settling';
  });
  // Plan §2: figures move only with a run's trailing `chat_updated`. A chats-list refetch while the run is
  // active must not expose mid-run totals, so keep the last idle usage and show that until the run ends.
  const idleUsage = useRef(idleUsageByChat.get(chat.id) ?? chat.usage);
  if (!active) {
    idleUsage.current = chat.usage;
    idleUsageByChat.set(chat.id, chat.usage);
  }
  const usage = active ? idleUsage.current : chat.usage;

  // Before the first reply the counter has nothing to say (the board's "New chat" state is dropped, plan §2).
  // During a new chat's first reply the idle snapshot has 0 requests, so the counter stays hidden (acceptance C1).
  if (usage.requests === 0) return null;

  const model = models.data?.find((m) => m.id === chat.model);
  const view = contextView(usage.contextTokens, model?.contextLength ?? null);
  const limitNote = !model
    ? 'Context limit unavailable.'
    : model.contextLength === null
      ? "This model doesn't report a context limit."
      : null;

  return (
    <ContextUsagePopover
      chat={chat}
      usage={usage}
      modelName={modelName(model, chat.model)}
      view={view}
      limitNote={limitNote}
    >
      <button
        type="button"
        title="Context used in this chat"
        data-level={view.level}
        className={cx(
          'inline-flex h-10 shrink-0 items-center rounded-[10px] px-2.5 font-mono text-[12.5px] whitespace-nowrap text-text-secondary tabular-nums',
          'hover:bg-overlay-ghost hover:text-text',
          'aria-expanded:bg-surface-raised aria-expanded:text-text aria-expanded:shadow-[inset_0_0_0_1px_var(--color-border-control)]',
        )}
      >
        <span className="sr-only">Context used: </span>
        <span className={cx(view.level === 'high' && 'text-accent-2', view.level === 'full' && 'text-danger')}>
          {view.usedShort}
        </span>
        <span className="ml-[0.4em] text-text-faint">/ {view.limitShort}</span>
      </button>
    </ContextUsagePopover>
  );
}
