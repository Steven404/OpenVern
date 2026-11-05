// F1: the Context popover (plan §5.1). Uses the shared Popover so Esc / an outside click close it and focus
// returns to the counter. The counter that opens it is passed in by `ContextUsageButton`.

import { cx, Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui';
import { PROVIDER_LABEL } from '@shared/constants';
import type { ChatSummary, ChatUsage } from '@shared/types';
import type { ReactNode } from 'react';
import { type ContextLevel, type ContextView, exact, formatDate, money } from './format';

/** Only the percentage and the bar carry the level; the figures below never change colour. */
const pctTone: Record<ContextLevel, string> = {
  ok: 'text-text',
  high: 'text-accent-2',
  full: 'text-danger',
  unknown: 'text-text-faint',
};
const fillTone: Record<ContextLevel, string> = {
  ok: 'bg-text-secondary',
  high: 'bg-accent-2',
  full: 'bg-danger',
  unknown: 'bg-text-secondary',
};

export interface ContextUsagePopoverProps {
  chat: ChatSummary;
  /** The figures to show: the chat's usage, or the run-start snapshot while a run is active. */
  usage: ChatUsage;
  /** The model's display name (`modelName()`), falling back to the id. */
  modelName: string;
  view: ContextView;
  /** The unknown-limit note; null when the limit is known. */
  limitNote: string | null;
  /** The counter button; it is the popover's trigger. */
  children: ReactNode;
}

export function ContextUsagePopover({ chat, usage, modelName, view, limitNote, children }: ContextUsagePopoverProps) {
  const pct = view.pct === null ? null : Math.min(Math.max(view.pct, 0), 100);
  const fill = pct ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        role="dialog"
        aria-label="Context"
        data-level={view.level}
        className={cx(
          'w-[352px] origin-top-right px-[18px] pt-4 pb-[18px]',
          'transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]',
          'starting:translate-y-1 starting:scale-[.98] starting:opacity-0 motion-reduce:transition-none',
        )}
      >
        <h3 className="m-0 text-[14px] font-semibold">Context</h3>
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <span
            className={cx(
              'text-[22px] leading-[1.2] font-semibold tracking-[-0.01em] tabular-nums',
              pctTone[view.level],
            )}
          >
            {view.pctLabel}
          </span>
          <span className="font-mono text-[12.5px] whitespace-nowrap text-text-faint tabular-nums" title={view.exact}>
            <span className="text-text-body">{view.usedShort}</span>
            <span className="ml-[0.35em]">{view.tail}</span>
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct === null ? undefined : Math.round(pct)}
          aria-valuetext={view.pctLabel}
          className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-raised-hover"
        >
          <div
            className={cx(
              'h-full rounded-full transition-[width,background-color] duration-[350ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
              fillTone[view.level],
              fill > 0 ? 'min-w-[3px]' : 'min-w-0',
            )}
            style={{ width: `${fill}%` }}
          />
        </div>
        {limitNote ? <p className="mt-2.5 text-[12.5px] text-text-muted">{limitNote}</p> : null}
        <div aria-hidden="true" className="mt-[18px] mb-4 h-px bg-border-tool" />
        <dl className="m-0 grid grid-cols-2 gap-x-5 gap-y-4">
          <Field label="Provider">{PROVIDER_LABEL}</Field>
          <Field label="Model" title={modelName}>
            {modelName}
          </Field>
          <Field label="Total cost" numeric>
            {money(usage.costUsd)}
          </Field>
          <Field label="Total tokens used" numeric>
            {exact(usage.promptTokens + usage.completionTokens)}
          </Field>
          <Field label="Created">{formatDate(chat.createdAt)}</Field>
          <Field label="Last activity">{formatDate(chat.updatedAt)}</Field>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function Field({
  label,
  title,
  numeric = false,
  children,
}: {
  label: string;
  title?: string;
  /** Mono, for the count-like figures (cost and tokens). */
  numeric?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] text-text-muted">{label}</dt>
      <dd
        title={title}
        className={cx('mt-0.5 truncate', numeric ? 'font-mono text-[13px] leading-[21px] tabular-nums' : 'text-[14px]')}
      >
        {children}
      </dd>
    </div>
  );
}
