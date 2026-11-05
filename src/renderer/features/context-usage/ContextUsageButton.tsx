// F1: the context counter in the chat header (plan §5.1). Hidden until the chat has a finished request, then
// reads `used / limit`; clicking it opens the Context popover. The figures come from `chat.usage`, which the
// trailing `chat_updated` of a run patches into the cached summary, so they change when a reply finishes.

import { cx } from '@renderer/components/ui';
import { modelName } from '@renderer/features/composer/models';
import { useModels } from '@renderer/features/composer/queries';
import type { ChatSummary } from '@shared/types';
import { ContextUsagePopover } from './ContextUsagePopover';
import { contextView } from './format';

export function ContextUsageButton({ chat }: { chat: ChatSummary }) {
  const models = useModels();
  // Before the first reply the counter has nothing to say (the board's "New chat" state is dropped, plan §2).
  if (chat.usage.requests === 0) return null;

  const model = models.data?.find((m) => m.id === chat.model);
  const view = contextView(chat.usage.contextTokens, model?.contextLength ?? null);

  return (
    <ContextUsagePopover chat={chat} modelName={modelName(model, chat.model)} view={view}>
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
