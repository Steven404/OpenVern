import { Check, ChevronRight, X } from 'lucide-react';
import { memo, useId, useState } from 'react';
import { Spinner } from '../../components/ui';
import { formatDuration } from '../composer/format';
import { ToolCallRow, toolBlockEqual } from './ToolCallRow';
import { clauseText, type GroupSummary, summarizeGroup } from './tool-summary';
import type { ToolGroupItem } from './turns';

export interface ToolGroupProps {
  group: ToolGroupItem;
}

/** Re-render only when the group's identity, liveness or anything a call or its result renders changes. */
export function toolGroupPropsEqual(prev: ToolGroupProps, next: ToolGroupProps): boolean {
  const a = prev.group;
  const b = next.group;
  return (
    a.key === b.key &&
    a.live === b.live &&
    a.blocks.length === b.blocks.length &&
    a.blocks.every((block, i) => {
      const other = b.blocks[i];
      return !!other && toolBlockEqual(block, other);
    })
  );
}

/**
 * A run of tool calls as one card: a one-line summary that opens into flat call rows. The open state is local and
 * lives under the group's key, so it survives the group growing and settling while the turn streams.
 */
export const ToolGroup = memo(function ToolGroup({ group }: ToolGroupProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const summary = summarizeGroup(group);

  return (
    <div
      className="overflow-hidden rounded-[10px] bg-card text-[13px] leading-5 text-text-secondary"
      data-testid="tool-group"
      data-state={summary.state}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={summary.text}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-inherit hover:bg-overlay-row focus-visible:outline-offset-[-2px]"
      >
        <span aria-hidden="true" className="flex shrink-0">
          <GroupStateIcon state={summary.state} />
        </span>
        <span className="min-w-0 flex-1 truncate" aria-hidden="true">
          <GroupLabel summary={summary} />
        </span>
        {summary.durationMs > 0 && (
          <span className="font-mono text-[11px] text-text-faint">{formatDuration(summary.durationMs)}</span>
        )}
        <ChevronRight
          aria-hidden="true"
          size={13}
          className={`shrink-0 text-text-faint transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div id={panelId} className="border-t border-border-tool">
          {group.blocks.map((b) => (
            <ToolCallRow key={b.key} block={b} variant="inGroup" />
          ))}
        </div>
      )}
    </div>
  );
}, toolGroupPropsEqual);

function GroupStateIcon({ state }: { state: GroupSummary['state'] }) {
  if (state === 'live') return <Spinner size={14} className="text-text-muted" />;
  if (state === 'failed') return <X size={14} strokeWidth={2} className="text-danger" />;
  return <Check size={14} strokeWidth={2} className="text-success" />;
}

function GroupLabel({ summary }: { summary: GroupSummary }) {
  const live = summary.state === 'live';
  const suffixes = (
    <>
      {summary.failed > 0 && <span className="text-danger"> · {summary.failed} failed</span>}
      {summary.notRun > 0 && <span className="text-text-faint"> · {summary.notRun} not run</span>}
    </>
  );
  const clauses = summary.clauses.map((c, i) => (
    <span key={`${c.verb}-${c.noun}`}>
      {i > 0 && ', '}
      <ClauseText clause={c} capitalize={!live && i === 0} />
    </span>
  ));
  if (live) {
    return (
      <>
        <span className="font-mono text-[12px]">{summary.current}</span>
        {clauses.length > 0 && <span className="text-text-faint"> · {clauses}</span>}
        {suffixes}
      </>
    );
  }
  return (
    <>
      {clauses}
      {suffixes}
    </>
  );
}

/** A clause with its file names in mono. The summary only passes names that are unique within the clause. */
function ClauseText({ clause, capitalize }: { clause: GroupSummary['clauses'][number]; capitalize: boolean }) {
  if (!clause.names) return <>{clauseText(clause, capitalize)}</>;
  const verb = capitalize ? clause.verb.charAt(0).toUpperCase() + clause.verb.slice(1) : clause.verb;
  return (
    <>
      {verb}{' '}
      {clause.names.map((name, i) => (
        <span key={name}>
          {i > 0 && ' and '}
          <span className="font-mono text-[12px]">{name}</span>
        </span>
      ))}
    </>
  );
}
