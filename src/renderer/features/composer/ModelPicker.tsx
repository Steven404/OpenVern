import type { ModelInfo } from '@shared/types';
import { Command } from 'cmdk';
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger, Spinner } from '../../components/ui';
import { formatContext } from './format';
import { modelName, modelProvider } from './models';

export interface ModelPickerProps {
  /** Selected model id. */
  value: string;
  models: ModelInfo[] | undefined;
  loading?: boolean;
  /** Message when the model list could not be loaded. */
  loadError?: string | null;
  /** No API key configured: the trigger reads "Add API key" and calls `onAddKey`. */
  noKey?: boolean;
  onChange: (id: string) => void;
  onAddKey: () => void;
  onReload?: () => void;
}

/** Ghost trigger shared with `EffortPicker` (F3), so the two pickers read as one control group. */
export const triggerClass =
  'min-h-9 gap-1.5 rounded-[10px] px-2.5 text-[13.5px] font-normal text-text-secondary hover:bg-overlay-ghost hover:text-text';

/** Matches when every whitespace-separated word of the search occurs in the model's name or id. */
const filter = (value: string, search: string) => {
  const haystack = value.toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
    ? 1
    : 0;
};

/** S7.10: searchable model list (cmdk in a popover) with context size and Tools / Vision badges. */
export function ModelPicker({
  value,
  models,
  loading,
  loadError,
  noKey,
  onChange,
  onAddKey,
  onReload,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);

  if (noKey) {
    return (
      <Button variant="ghost" className={triggerClass} onClick={onAddKey}>
        Add API key
      </Button>
    );
  }

  const current = models?.find((m) => m.id === value);
  const label = loading && !models ? 'Loading models…' : modelName(current, value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={triggerClass}
          aria-label={`Model: ${label}`}
          title={current ? current.name : value}
        >
          <span className="max-w-[220px] truncate">{label}</span>
          {loading && !models ? <Spinner size={13} /> : <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-[min(420px,calc(100vw-32px))] overflow-hidden p-0">
        {loadError && !models ? (
          <div className="flex flex-col items-start gap-3 p-4 text-[13.5px] text-text-muted">
            <p className="m-0">{loadError}</p>
            {onReload && (
              <Button size="sm" onClick={onReload}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <Command label="Models" filter={filter} loop>
            <div className="border-b border-border-control px-3">
              <Command.Input
                placeholder="Search models…"
                aria-label="Search models"
                className="h-11 w-full border-0 bg-transparent text-[14px] text-text outline-none placeholder:text-text-faint"
              />
            </div>
            <Command.List className="max-h-[320px] overflow-y-auto scrollbar-stable p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[13.5px] text-text-faint">
                No models match.
              </Command.Empty>
              {(models ?? []).map((m) => (
                <Command.Item
                  key={m.id}
                  value={`${m.name} ${m.id}`}
                  onSelect={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[8px] px-2.5 py-1.5 text-text-secondary data-[selected=true]:bg-overlay-ghost data-[selected=true]:text-text"
                >
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-[13.5px]">{modelName(m, m.id)}</span>
                    <span className="truncate text-[11.5px] text-text-faint">{modelProvider(m)}</span>
                  </span>
                  {m.contextLength ? (
                    <span className="shrink-0 font-mono text-[11.5px] text-text-faint">
                      {formatContext(m.contextLength)}
                    </span>
                  ) : null}
                  <span className="flex shrink-0 gap-1">
                    {m.supportsTools && <Badge>Tools</Badge>}
                    {m.supportsImages && <Badge>Vision</Badge>}
                  </span>
                  <Check
                    aria-hidden="true"
                    size={14}
                    strokeWidth={2.4}
                    className={`shrink-0 text-accent ${m.id === value ? '' : 'invisible'}`}
                  />
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border-control px-1.5 py-px text-[10.5px] leading-4 text-text-muted">
      {children}
    </span>
  );
}
