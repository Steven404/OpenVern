import { Check, ChevronRight, Clock, X } from 'lucide-react';
import { memo, useId, useState } from 'react';
import { Spinner } from '../../components/ui';
import { formatDuration } from '../composer/format';
import type { ToolBlock } from './turns';

/** Pretty-prints the model's raw JSON arguments; falls back to the raw string. */
export function formatArgs(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 2);
  } catch {
    return argsJson;
  }
}

/** Short label for a call that has no result yet (the result's `summary` replaces it). */
export function summarizeArgs(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const path = typeof args.path === 'string' ? args.path : '';
    if (typeof args.query === 'string') return path ? `"${args.query}" in ${path}` : `"${args.query}"`;
    return path;
  } catch {
    return '';
  }
}

export interface ToolCallRowProps {
  block: Pick<ToolBlock, 'call' | 'result' | 'state'>;
  /** `card`: a standalone row on its own card. `inGroup`: a flat row on the group's card. */
  variant?: 'card' | 'inGroup';
}

/** Re-render only when the call, its state or its result changes; streamed text elsewhere must not touch rows. */
export function toolCallRowPropsEqual(prev: ToolCallRowProps, next: ToolCallRowProps): boolean {
  return (
    prev.variant === next.variant &&
    prev.block.call.id === next.block.call.id &&
    prev.block.call.argsJson === next.block.call.argsJson &&
    prev.block.state === next.block.state &&
    prev.block.result?.id === next.block.result?.id
  );
}

/** One tool call: muted clock while queued, spinner while running, then ✓ / ✕, with expandable arguments and output. */
export const ToolCallRow = memo(function ToolCallRow({ block, variant = 'card' }: ToolCallRowProps) {
  const { call, result, state } = block;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const summary = result?.summary || summarizeArgs(call.argsJson);
  const inGroup = variant === 'inGroup';

  return (
    <div
      className={`text-[13px] leading-5 text-text-secondary ${inGroup ? '' : 'overflow-hidden rounded-[10px] bg-card'}`}
      data-testid="tool-row"
      data-state={state}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 text-left text-inherit hover:bg-overlay-row focus-visible:outline-offset-[-2px] ${inGroup ? 'py-1' : 'py-1.5'}`}
      >
        <ToolStateIcon state={state} />
        <span className="font-mono text-[12px]">{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-text-muted">{summary}</span>
        {result ? (
          <span className="font-mono text-[11px] text-text-faint">{formatDuration(result.durationMs)}</span>
        ) : state === 'queued' ? (
          <span className="font-mono text-[11px] text-text-faint">queued</span>
        ) : state === 'skipped' ? (
          <span className="font-mono text-[11px] text-text-faint">not run</span>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          size={13}
          className={`shrink-0 text-text-faint transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div id={panelId} className={`flex flex-col gap-2 px-3 py-2 ${inGroup ? '' : 'border-t border-border-tool'}`}>
          <ToolSection label="Arguments" text={formatArgs(call.argsJson)} />
          <ToolSection
            label="Output"
            text={
              result
                ? result.output || '(empty)'
                : state === 'running'
                  ? 'Running…'
                  : state === 'queued'
                    ? 'Waiting to run.'
                    : 'No output.'
            }
            danger={state === 'failed'}
          />
        </div>
      )}
    </div>
  );
}, toolCallRowPropsEqual);

function ToolStateIcon({ state }: { state: ToolBlock['state'] }) {
  if (state === 'running') return <Spinner size={14} className="text-text-muted" />;
  if (state === 'queued')
    return <Clock aria-label="Queued" size={14} strokeWidth={2} className="shrink-0 text-text-faint" />;
  if (state === 'ok')
    return <Check aria-label="Succeeded" size={14} strokeWidth={2} className="shrink-0 text-success" />;
  if (state === 'failed') return <X aria-label="Failed" size={14} strokeWidth={2} className="shrink-0 text-danger" />;
  return <X aria-label="Not run" size={14} strokeWidth={2} className="shrink-0 text-text-faint" />;
}

function ToolSection({ label, text, danger = false }: { label: string; text: string; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] tracking-[0.08em] text-text-faint uppercase">{label}</span>
      <pre
        className={`m-0 max-h-[320px] overflow-auto scrollbar-stable whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] ${danger ? 'text-danger' : 'text-text-code'}`}
      >
        {text}
      </pre>
    </div>
  );
}
