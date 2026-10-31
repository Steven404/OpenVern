import { Paperclip, Plus } from 'lucide-react';
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/ui';

export interface AttachMenuProps {
  /** Opens the OS file picker. */
  onAddFiles: () => void;
  disabled?: boolean;
}

/** S7.11: the (+) button; its menu has one item, "Add files". */
export function AttachMenu({ onAddFiles, disabled }: AttachMenuProps) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton aria-label="Attach file" tooltip="Attach file" disabled={disabled}>
          <Plus aria-hidden="true" size={18} strokeWidth={1.75} />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="start" side="top">
        <MenuItem icon={<Paperclip size={16} />} onSelect={onAddFiles}>
          Add files
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
