import {
  ConfirmDialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from '@renderer/components/ui';
import { RenameDialog } from '@renderer/features/chat-header';
import { ApiError } from '@renderer/lib/api-client';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { NEW_CHAT_PROJECT_PARAM, paths } from '@renderer/lib/routes';
import { useUiStore } from '@renderer/stores/ui';
import type { ProjectListItem } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

export interface ProjectMenuProps {
  project: ProjectListItem;
  /** Lets the row keep the "…" visible (and hide the count) while the menu is open. */
  onMenuOpenChange?: (open: boolean) => void;
}

function removeDescription(project: ProjectListItem): string {
  const n = project.chatCount;
  const moved = n === 0 ? '' : n === 1 ? ' Its chat moves to Chats.' : ` Its ${n} chats move to Chats.`;
  return `Remove "${project.name}" from OpenVern?${moved} Files on disk are not touched.`;
}

/** S6.4: the sidebar project row's "…" button — New chat here · Rename · Remove. Position it from the row. */
export function ProjectMenu({ project, onMenuOpenChange }: ProjectMenuProps) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const collapseProject = useUiStore((s) => s.collapseProject);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: async () => {
      setRemoveOpen(false);
      collapseProject(project.id);
      if (new URLSearchParams(location.search).get(NEW_CHAT_PROJECT_PARAM) === project.id) navigate(paths.newChat());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats }),
        // Open chats of this project are now loose chats: refetch every cached `chat(id)`.
        queryClient.invalidateQueries({ queryKey: ['chat'] }),
      ]);
    },
  });

  // Shown inline; the dialog stays open so the user can retry (a retry clears it, a success closes the dialog).
  const removeError = remove.error
    ? remove.error instanceof ApiError
      ? remove.error.info.message
      : 'Something went wrong. Try again.'
    : undefined;

  return (
    <>
      <Menu onOpenChange={onMenuOpenChange}>
        <MenuTrigger asChild>
          <IconButton
            ref={triggerRef}
            size="sm"
            aria-label={`Options for ${project.name}`}
            className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </IconButton>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem icon={<MessageSquarePlus size={15} />} onSelect={() => navigate(paths.newChat(project.id))}>
            New chat here
          </MenuItem>
          <MenuItem icon={<Pencil size={15} />} onSelect={() => setRenameOpen(true)}>
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            icon={<Trash2 size={15} />}
            onSelect={() => {
              remove.reset();
              setRemoveOpen(true);
            }}
          >
            Remove
          </MenuItem>
        </MenuContent>
      </Menu>

      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename project"
        label="Name"
        initialValue={project.name}
        returnFocusRef={triggerRef}
        onSubmit={async (name) => {
          await api.renameProject(project.id, name);
          await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
        }}
      />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove project?"
        description={removeDescription(project)}
        confirmLabel="Remove"
        danger
        loading={remove.isPending}
        returnFocusRef={triggerRef}
        onConfirm={() => remove.mutate()}
      >
        {removeError ? (
          <p role="alert" className="text-[13px] text-danger">
            {removeError}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
