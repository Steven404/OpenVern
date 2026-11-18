import { LIMITS } from '@shared/constants';
import type { EditMode, Id } from '@shared/types';
import { Eye, Zap } from 'lucide-react';
import { type RefObject, useId, useRef, useState } from 'react';
import {
  Button,
  cx,
  Dialog,
  DialogContent,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../../components/ui';
import { useUiStore } from '../../stores/ui';
import { triggerClass } from './ModelPicker';

export interface EditModePickerProps {
  value: EditMode;
  onChange: (mode: EditMode) => void;
  /** The project the edits go to: its name for the warning, and whether its folder is in a Git work tree. */
  project: { id: Id; name: string; inGitRepo: boolean };
  /** A run is active: a change applies from the next message. */
  running?: boolean;
}

const LABELS: Record<EditMode, string> = { review: 'Review', auto: 'Auto' };
const DESCRIPTIONS: Record<EditMode, string> = {
  review: "You approve each edit before it's written.",
  auto: 'Edits are written as the model works. You can undo each turn.',
};
const ICONS: Record<EditMode, typeof Eye> = { review: Eye, auto: Zap };

/**
 * The Review / Auto chip next to the effort and model pickers. Built like `EffortPicker`: a ghost trigger that
 * collapses to its icon in a narrow toolbar, and an upward menu with a radio group. Auto is drawn in the warning tone
 * so a chat that writes files without asking always looks different.
 *
 * Turning Auto on for a project whose folder isn't in Git asks first, once per project on this device: there is no
 * history to go back to beyond the app's own per-turn Undo.
 */
export function EditModePicker({ value, onChange, project, running = false }: EditModePickerProps) {
  const acknowledged = useUiStore((s) => s.autoNoGitAcknowledged[project.id] === true);
  const acknowledge = useUiStore((s) => s.acknowledgeAutoNoGit);
  const [warnOpen, setWarnOpen] = useState(false);
  // The dialog opens from a menu item, which unmounts with its menu: focus goes back to the chip instead.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const Icon = ICONS[value];
  const label = LABELS[value];
  const tone = value === 'auto' ? 'text-accent-2' : undefined;

  const pick = (next: EditMode) => {
    if (next === value) return;
    if (next === 'auto' && !project.inGitRepo && !acknowledged) {
      setWarnOpen(true);
      return;
    }
    onChange(next);
  };

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button
            ref={triggerRef}
            variant="ghost"
            data-testid="edit-mode-chip"
            data-mode={value}
            className={triggerClass}
            aria-label={`Edit mode: ${label}`}
            title="How the model's edits reach your files"
          >
            {/* The tone sits on the children: the trigger's own text colour (and its hover) would win over it. */}
            <Icon aria-hidden="true" size={16} strokeWidth={1.75} className={tone} />
            <span className={cx('hidden @xl/toolbar:inline', tone)}>{label}</span>
          </Button>
        </MenuTrigger>
        <MenuContent
          side="top"
          align="end"
          aria-describedby={running ? hintId : undefined}
          className="w-[min(280px,calc(100vw-32px))]"
        >
          <MenuRadioGroup value={value} onValueChange={(next) => pick(next as EditMode)}>
            {(['review', 'auto'] as const).map((mode) => (
              <MenuRadioItem
                key={mode}
                value={mode}
                textValue={LABELS[mode]}
                data-testid={`edit-mode-${mode}`}
                className="py-1.5"
              >
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className={cx(mode === 'auto' && 'text-accent-2')}>{LABELS[mode]}</span>
                  <span className="text-[11.5px] text-text-faint">{DESCRIPTIONS[mode]}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {running && (
            <>
              <MenuSeparator />
              <p id={hintId} className="m-0 px-2.5 py-1 text-[11.5px] leading-snug text-text-faint">
                Applies from your next message.
              </p>
            </>
          )}
        </MenuContent>
      </Menu>
      <NoGitDialog
        open={warnOpen}
        onOpenChange={setWarnOpen}
        projectName={project.name}
        returnFocusRef={triggerRef}
        onConfirm={() => {
          acknowledge(project.id);
          setWarnOpen(false);
          onChange('auto');
        }}
      />
    </>
  );
}

function NoGitDialog({
  open,
  onOpenChange,
  projectName,
  returnFocusRef,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Turn on Auto for a folder without Git?"
        description={
          <>
            {projectName} isn't a Git repository. In Auto, the model's edits are written to your files as it works.
            OpenVern can undo each of the last {LIMITS.autoUndoTurns} turns in this chat, but there is no other history
            to go back to.
          </>
        }
        width={460}
        returnFocusRef={returnFocusRef}
        data-testid="no-git-dialog"
        footer={
          <>
            {/* Cancel changes nothing: the chat stays in Review and the warning will show again next time. */}
            <Button variant="ghost" data-testid="no-git-keep-review" onClick={() => onOpenChange(false)}>
              Keep Review
            </Button>
            <Button variant="primary" data-testid="no-git-turn-on-auto" onClick={onConfirm}>
              Turn on Auto
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
