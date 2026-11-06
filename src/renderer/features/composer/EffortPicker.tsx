import { REASONING_EFFORTS } from '@shared/constants';
import type { ReasoningEffort } from '@shared/types';
import { useId } from 'react';
import {
  Button,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../../components/ui';
import { triggerClass } from './ModelPicker';

export interface EffortPickerProps {
  /** Selected effort; `null` = Default (no `reasoning` field is sent). */
  value: ReasoningEffort | null;
  onChange: (effort: ReasoningEffort | null) => void;
}

/** Radio value for "Default" (Radix radio values must be strings, and `null` is not one). */
const DEFAULT_EFFORT = '__default__';

const LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** One-line meaning of each level, shown under its name. Default and None explain themselves. */
const DESCRIPTIONS: Partial<Record<ReasoningEffort, string>> = {
  none: 'No reasoning',
};

/**
 * F3 (plan §5.3): reasoning-effort selector next to the model picker. Mirrors how `ModelPicker` is built — a ghost
 * trigger and an upward menu with a radio group. The caller hides it for models without reasoning support.
 */
export function EffortPicker({ value, onChange }: EffortPickerProps) {
  const label = value === null ? 'Default' : LABELS[value];
  const hintId = useId();

  return (
    <Menu>
      <MenuTrigger asChild>
        {/* No aria-label: the visible "Effort: …" text is the accessible name (plan §5.3). */}
        <Button variant="ghost" className={triggerClass} title="Reasoning effort">
          Effort: {label}
        </Button>
      </MenuTrigger>
      <MenuContent side="top" align="end" aria-describedby={hintId} className="w-[min(240px,calc(100vw-32px))]">
        <MenuRadioGroup
          value={value ?? DEFAULT_EFFORT}
          onValueChange={(next) => onChange(next === DEFAULT_EFFORT ? null : (next as ReasoningEffort))}
        >
          <MenuRadioItem value={DEFAULT_EFFORT} textValue="Default">
            <ItemText name="Default" description="The model's own setting" />
          </MenuRadioItem>
          {REASONING_EFFORTS.map((effort) => (
            <MenuRadioItem key={effort} value={effort} textValue={LABELS[effort]}>
              <ItemText name={LABELS[effort]} description={DESCRIPTIONS[effort]} />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <p id={hintId} className="m-0 px-2.5 py-1 text-[11.5px] leading-snug text-text-faint">
          Higher effort thinks longer and costs more.
        </p>
      </MenuContent>
    </Menu>
  );
}

function ItemText({ name, description }: { name: string; description?: string }) {
  if (!description) return <span className="min-w-0 truncate">{name}</span>;
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate">{name}</span>
      <span className="truncate text-[11.5px] text-text-faint">{description}</span>
    </span>
  );
}
