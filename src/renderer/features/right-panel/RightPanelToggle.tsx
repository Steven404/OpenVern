import { cx, IconButton } from '@renderer/components/ui';
import { useUiStore } from '@renderer/stores/ui';
import { RightPanelIcon } from './icons';
import { RIGHT_PANEL_TOGGLE_ID } from './RightPanel';

/** Chat-header button for the right panel (also `Ctrl+]`). */
export function RightPanelToggle() {
  const open = useUiStore((s) => s.rightPanelOpen);
  const toggle = useUiStore((s) => s.toggleRightPanel);
  return (
    <IconButton
      id={RIGHT_PANEL_TOGGLE_ID}
      size="lg"
      aria-label="Toggle right panel"
      aria-pressed={open}
      aria-controls="right-panel"
      tooltip="Toggle right panel (Ctrl ])"
      onClick={toggle}
      className={cx(open && 'bg-surface-raised text-text shadow-[inset_0_0_0_1px_var(--color-border-control)]')}
    >
      <RightPanelIcon />
    </IconButton>
  );
}
