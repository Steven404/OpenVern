import type { ApiErrorInfo } from '@shared/errors';
import { Info } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Button } from '../../components/ui';
import { ErrorCard } from './ErrorCard';
import { Markdown } from './Markdown';
import { ToolCallRow } from './ToolCallRow';
import type { Block, TextBlock } from './turns';

export interface AssistantTurnProps {
  blocks: Block[];
  /** Small muted note before the content (e.g. the project tree timed out). */
  notice?: string;
  /** "Thinking…" before the first token (and between tool calls and the next reply). */
  waiting?: boolean;
  /** Rendered after the blocks (the Proposed edits card). */
  footer?: ReactNode;
  /** Run-level error to show at the end of the turn (no persisted message carries it). */
  error?: ApiErrorInfo | null;
  /** The run was stopped but no message carries the `stopped` status yet. */
  stopped?: boolean;
  /** The run-level error card offers "Retry" even if the error is not retryable (the message never persisted). */
  forceRetry?: boolean;
  /** Present only on the last turn when no run is active: enables "Retry". */
  onRetry?: () => void;
}

/** One article per turn, with texts and tool rows in order. */
export const AssistantTurn = memo(function AssistantTurn({
  blocks,
  notice,
  waiting = false,
  footer,
  error,
  stopped = false,
  forceRetry = false,
  onRetry,
}: AssistantTurnProps) {
  const lastText = blocks.findLast((b) => b.kind === 'text');
  const hasStoppedBlock = blocks.some((b) => b.kind === 'text' && b.status === 'stopped');
  return (
    <article
      data-testid="assistant-turn"
      className="flex min-w-0 flex-col gap-[14px] text-[15.5px] leading-[1.65] text-text-body"
    >
      {notice && (
        <p role="status" className="m-0 flex items-start gap-1.5 text-[13px] leading-snug text-text-muted">
          <Info aria-hidden="true" size={14} className="mt-[3px] shrink-0" />
          <span>{notice}</span>
        </p>
      )}

      {blocks.map((b) =>
        b.kind === 'tool' ? (
          <ToolCallRow key={b.key} block={b} />
        ) : (
          <TextPart key={b.key} block={b} onRetry={b === lastText ? onRetry : undefined} />
        ),
      )}

      {footer}

      {waiting && (
        <p role="status" className="m-0 animate-pulse font-mono text-[13px] text-text-faint motion-reduce:animate-none">
          Thinking…
        </p>
      )}
      {stopped && !hasStoppedBlock && <StoppedLabel onRetry={onRetry} />}
      {error && <ErrorCard error={error} onRetry={onRetry} forceRetry={forceRetry} />}
    </article>
  );
});

function TextPart({ block, onRetry }: { block: TextBlock; onRetry?: () => void }) {
  return (
    <>
      {block.text ? <Markdown text={block.text} streaming={block.streaming} /> : null}
      {block.status === 'stopped' && <StoppedLabel onRetry={onRetry} />}
      {block.status === 'error' && block.error && <ErrorCard error={block.error} onRetry={onRetry} />}
    </>
  );
}

function StoppedLabel({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-3 text-[13px] text-text-faint">
      <span data-testid="stopped-label">Stopped</span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
