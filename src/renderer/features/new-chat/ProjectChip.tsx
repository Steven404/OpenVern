import type { Id, ProjectListItem } from '@shared/types';
import { FolderPlus } from 'lucide-react';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../../components/ui';
import { useUiStore } from '../../stores/ui';

const NONE = '__none__';

export interface ProjectChipProps {
  projects: ProjectListItem[];
  /** Selected project id, or `null` for "No project". */
  value: Id | null;
  onChange: (projectId: Id | null) => void;
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-accent-2)"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

/** D18: the "No project" chip; its menu lists "No project", every project and "Add project…". */
export function ProjectChip({ projects, value, onChange }: ProjectChipProps) {
  const openNewProject = useUiStore((s) => s.openNewProject);
  const current = value ? projects.find((p) => p.id === value) : undefined;

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Project: ${current?.name ?? 'No project'}`}
          className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-[8px] bg-bubble px-2.5 text-[13px] text-text-secondary hover:bg-surface-raised-hover hover:text-text"
        >
          <FolderIcon />
          <span className="max-w-[200px] truncate">{current?.name ?? 'No project'}</span>
        </button>
      </MenuTrigger>
      <MenuContent align="start" side="top" className="max-h-[320px] min-w-56">
        <MenuRadioGroup value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
          <MenuRadioItem value={NONE}>No project</MenuRadioItem>
          {projects.map((p) => (
            <MenuRadioItem key={p.id} value={p.id}>
              <span className="truncate">{p.name}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<FolderPlus size={16} />} onSelect={openNewProject}>
          Add project…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
