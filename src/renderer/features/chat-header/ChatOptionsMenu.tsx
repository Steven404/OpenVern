import { useProjects } from '@renderer/app/queries';
import {
  ConfirmDialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '@renderer/components/ui';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { paths } from '@renderer/lib/routes';
import { patchChatSummary, useRunsStore } from '@renderer/stores/runs';
import type { ChatSummary } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Folder, FolderInput, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { RenameDialog } from './RenameDialog';

/** Radio value for "No project" (Radix radio values must be strings). */
const NO_PROJECT = '__none__';

/** D9: the "…" button in the chat header — Rename · Move to project ▸ · Archive (no project only) · Delete. */
export function ChatOptionsMenu({ chat }: { chat: ChatSummary }) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const projects = useProjects();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.chats }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(chat.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    ]);

  const move = useMutation({
    mutationFn: (projectId: string | null) => api.updateChat(chat.id, { projectId }),
    onSettled: refresh,
  });

  // The server rejects archive changes while a reply is in progress, so the item waits for the run to finish.
  const streaming = useRunsStore((s) => {
    const st = s.runs[chat.id]?.status;
    return st === 'running' || st === 'settling';
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => api.updateChat(chat.id, { archived }),
    onSuccess: (summary) => patchChatSummary(queryClient, summary),
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: () => api.deleteChat(chat.id),
    onSuccess: async () => {
      navigate(paths.newChat());
      setDeleteOpen(false);
      queryClient.removeQueries({ queryKey: queryKeys.chat(chat.id) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
      ]);
    },
  });

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton ref={triggerRef} aria-label="Chat options" size="lg">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={<Pencil size={15} />} onSelect={() => setRenameOpen(true)}>
            Rename
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger icon={<FolderInput size={15} />}>Move to project</MenuSubTrigger>
            <MenuSubContent className="max-w-72">
              <MenuRadioGroup
                value={chat.projectId ?? NO_PROJECT}
                onValueChange={(value) => {
                  const next = value === NO_PROJECT ? null : value;
                  if (next !== chat.projectId) move.mutate(next);
                }}
              >
                <MenuRadioItem value={NO_PROJECT} icon={<Folder size={15} className="text-text-faint" />}>
                  No project
                </MenuRadioItem>
                {(projects.data ?? []).map((project) => (
                  <MenuRadioItem
                    key={project.id}
                    value={project.id}
                    icon={<Folder size={15} className="text-accent-2" />}
                  >
                    <span className="truncate">{project.name}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubContent>
          </MenuSub>
          {chat.projectId === null ? (
            <MenuItem
              icon={chat.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              disabled={streaming || archive.isPending}
              onSelect={() => archive.mutate(!chat.archived)}
            >
              {chat.archived ? 'Unarchive' : 'Archive'}
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 size={15} />} onSelect={() => setDeleteOpen(true)}>
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>

      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename chat"
        label="Title"
        initialValue={chat.title}
        returnFocusRef={triggerRef}
        onSubmit={async (title) => {
          await api.updateChat(chat.id, { title });
          await refresh();
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this chat?"
        description={`"${chat.title}" will be permanently deleted. This can't be undone.`}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        returnFocusRef={triggerRef}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
