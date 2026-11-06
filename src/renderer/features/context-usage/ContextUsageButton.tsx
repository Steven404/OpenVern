// F1: the context counter in the chat header (plan §5.1). Hidden until the chat has a finished request, then
// reads `used / limit`; clicking it opens the Context popover. When idle the figures come from `chat.usage`; while
// a run is active they come from the usage the runs store captured when it started, so they change only when the
// run has settled (plan §2: after the trailing `chat_updated` and the settle refetch), whatever the cached summary
// does in between.

import { cx } from '@renderer/components/ui';
import { modelName } from '@renderer/features/composer/models';
import { useModels } from '@renderer/features/composer/queries';
import { useRunsStore } from '@renderer/stores/runs';
import type { ChatSummary } from '@shared/types';
import { ContextUsagePopover } from './ContextUsagePopover';
import { contextView } from './format';

export function ContextUsageButton({ chat }: { chat: ChatSummary }) {
  const models = useModels();
  // Two narrow selectors: the run object changes on every stream event, these values don't.
  const active = useRunsStore((s) => {
    const status = s.runs[chat.id]?.status;
    return status === 'running' || status === 'settling';
  });
  const usageBefore = useRunsStore((s) => s.runs[chat.id]?.usageBefore ?? null);
  const usage = active ? usageBefore : chat.usage;

  // Before the first reply the counter has nothing to say (the board's "New chat" state is dropped, plan §2).
  // During a new chat's first reply `usageBefore` has 0 requests, so the counter stays hidden (acceptance C1).
  if (!usage || usage.requests === 0) return null;

  const model = models.data?.find((m) => m.id === chat.model);
  const view = contextView(usage.contextTokens, model?.contextLength ?? null);
  const limitNote = !model
    ? 'Context limit unavailable.'
    : !model.contextLength
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
          'inline-flex h-10 shrink-0 items-center rounded-[8px] px-2.5 font-mono text-[12.5px] whitespace-nowrap text-text-secondary tabular-nums',
          'hover:bg-overlay-ghost hover:text-text',
          'aria-expanded:bg-surface-raised aria-expanded:text-text',
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
