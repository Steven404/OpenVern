import { APP_NAME } from '@shared/constants';
import type { ApiErrorInfo } from '@shared/errors';
import { memo } from 'react';
import { Button } from '../../components/ui';
import { ErrorCard } from './ErrorCard';
import { Markdown } from './Markdown';
import { ToolCallRow } from './ToolCallRow';
import type { Block, TextBlock } from './turns';

export interface AssistantTurnProps {
  blocks: Block[];
  /** Tooltip on the header (model name). */
  modelLabel?: string;
  /** "Thinking…" before the first token (and between tool calls and the next reply). */
  waiting?: boolean;
  /** Run-level error to show at the end of the turn (no persisted message carries it). */
  error?: ApiErrorInfo | null;
  /** The run was stopped but no message carries the `stopped` status yet. */
  stopped?: boolean;
  /** The run-level error card offers "Retry" even if the error is not retryable (the message never persisted). */
  forceRetry?: boolean;
  /** Present only on the last turn when no run is active: enables "Retry". */
  onRetry?: () => void;
}

/** D11: avatar header + one article per turn, texts and tool rows in order. */
export const AssistantTurn = memo(function AssistantTurn({
  blocks,
  modelLabel,
  waiting = false,
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
      <div className="flex items-center gap-2.5" title={modelLabel}>
        <span
          aria-hidden="true"
          className="inline-flex size-[26px] items-center justify-center rounded-[8px] bg-accent font-display text-[14px] font-bold text-bg"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
          </svg>
        </span>
        <span className="text-[14px] font-semibold text-text">{APP_NAME}</span>
      </div>

      {blocks.map((b) =>
        b.kind === 'tool' ? (
          <ToolCallRow key={b.key} block={b} />
        ) : (
          <TextPart key={b.key} block={b} onRetry={b === lastText ? onRetry : undefined} />
        ),
      )}

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
