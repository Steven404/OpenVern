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
}

/** One tool call (D13): muted clock while queued, spinner while running, then ✓ / ✕, with expandable arguments and output. */
export const ToolCallRow = memo(function ToolCallRow({ block }: ToolCallRowProps) {
  const { call, result, state } = block;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const summary = result?.summary || summarizeArgs(call.argsJson);

  return (
    <div
      className="overflow-hidden rounded-[10px] bg-card text-[13.5px] text-text-secondary"
      data-testid="tool-row"
      data-state={state}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 py-2.5 text-left text-inherit hover:bg-overlay-row"
      >
        <ToolStateIcon state={state} />
        <span className="font-mono text-[12.5px]">{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-text-muted">{summary}</span>
        {result ? (
          <span className="font-mono text-[11.5px] text-text-faint">{formatDuration(result.durationMs)}</span>
        ) : state === 'queued' ? (
          <span className="font-mono text-[11.5px] text-text-faint">queued</span>
        ) : state === 'skipped' ? (
          <span className="font-mono text-[11.5px] text-text-faint">not run</span>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          size={14}
          className={`shrink-0 text-text-faint transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div id={panelId} className="flex flex-col gap-3 border-t border-border-tool px-3.5 py-3">
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
});

function ToolStateIcon({ state }: { state: ToolBlock['state'] }) {
  if (state === 'running') return <Spinner size={16} className="text-text-muted" />;
  if (state === 'queued')
    return <Clock aria-label="Queued" size={16} strokeWidth={2} className="shrink-0 text-text-faint" />;
  if (state === 'ok')
    return <Check aria-label="Succeeded" size={16} strokeWidth={2} className="shrink-0 text-success" />;
  if (state === 'failed') return <X aria-label="Failed" size={16} strokeWidth={2} className="shrink-0 text-danger" />;
  return <X aria-label="Not run" size={16} strokeWidth={2} className="shrink-0 text-text-faint" />;
}

function ToolSection({ label, text, danger = false }: { label: string; text: string; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] tracking-[0.08em] text-text-faint uppercase">{label}</span>
      <pre
        className={`m-0 max-h-[320px] overflow-auto scrollbar-stable whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.6] ${danger ? 'text-danger' : 'text-text-code'}`}
      >
        {text}
      </pre>
    </div>
  );
}
