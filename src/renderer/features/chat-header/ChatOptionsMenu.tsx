import { useProjects } from '@renderer/app/queries';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
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
import { useReplyEditMode } from '@renderer/features/composer/Composer';
import { NoGitDialog } from '@renderer/features/composer/NoGitDialog';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { paths } from '@renderer/lib/routes';
import { forgetEditMode, useEditModeEntry, writeChat } from '@renderer/stores/edit-modes';
import { patchChatSummary, useRunsStore } from '@renderer/stores/runs';
import { useUiStore } from '@renderer/stores/ui';
import type { ChatSummary, EditMode, Id, ProjectListItem } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Folder, FolderInput, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { RenameDialog } from './RenameDialog';

/** Radio value for "No project" (Radix radio values must be strings). */
const NO_PROJECT = '__none__';

/** D9: the "…" button in the chat header — Rename · Move to project ▸ · Archive / Unarchive · Delete. */
export function ChatOptionsMenu({ chat }: { chat: ChatSummary }) {
  // Re-keyed per chat, so a dialog opened for one chat (the no-Git move warning above all) closes when the header
  // shows another one, instead of being confirmed for it.
  return <ChatOptionsMenuInner key={chat.id} chat={chat} />;
}

/** One move: the chat it was decided for, travelling with the request rather than read when it fires. */
interface MoveRequest {
  chatId: Id;
  projectId: Id | null;
  editMode?: EditMode;
  expectedEditMode: EditMode;
  /** For a move that keeps Auto in a project: whether that project's folder was shown as inside Git. */
  expectedInGitRepo?: boolean;
}

function ChatOptionsMenuInner({ chat }: { chat: ChatSummary }) {
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

  const [moveError, setMoveError] = useState<string | null>(null);
  const move = useMutation({
    // A move carries the mode, so it goes through the shown-mode store: one mode-carrying PATCH at a time, its answer
    // is the shown mode, and a failure checks the server's mode again before Move or the chip are enabled.
    mutationFn: async ({ chatId, ...patch }: MoveRequest) => {
      const summary = await writeChat({ api, queryClient }, chatId, 'move', () => api.updateChat(chatId, patch));
      if (summary) patchChatSummary(queryClient, summary);
      return summary;
    },
    onMutate: () => setMoveError(null),
    // A refused move changed nothing, and nothing is retried here.
    onError: (err) => setMoveError(err instanceof Error && err.message ? err.message : "Couldn't move this chat."),
    onSettled: refresh,
  });

  // INVARIANT: an Auto chat never lands in a folder without Git unwarned. Moving it there is the same step as turning
  // Auto on there (the next turn writes to that folder without asking), so it asks the same question, once per
  // project. Switching to Review goes in the same PATCH as the move, so the chat is never in the new folder in Auto.
  // The question is decided from the mode the chip shows (the shown-mode store, rendered here), Move is disabled
  // until that mode is known (not while a mode change or its check is in flight), and the move carries that same
  // value as `expectedEditMode`: if the server's mode differs when it commits, it refuses the move, so a skipped
  // warning never rests on a mode the user wasn't shown. A move that keeps Auto in a project also carries the Git
  // status the decision rested on, so a folder that has left Git since is refused (and the list read again, so the
  // next try asks). The dialog keeps the chat it opened for, so a choice always moves that chat.
  //
  // INVARIANT: a chat never becomes able to write in Auto without the user having seen that it is in Auto. A chat in
  // Auto whose chip is hidden (no project, no key, a model without tools: the composer's own gate, from the same chat
  // and model the composer renders) has kept its mode out of sight, so moving it into a project asks first, even into
  // a Git folder. Into a folder without Git that isn't accepted yet, the no-Git question already says the chat is in
  // Auto, so that one dialog asks both.
  const shown = useEditModeEntry(chat.id);
  const composerModel = useRunsStore((s) => s.chatModels[chat.id]) ?? chat.model;
  const chip = useReplyEditMode(chat.id, chat.projectId, composerModel);
  const acknowledged = useUiStore((s) => s.autoNoGitAcknowledged);
  const acknowledge = useUiStore((s) => s.acknowledgeAutoNoGit);
  const [moveAsk, setMoveAsk] = useState<{
    chatId: Id;
    project: ProjectListItem;
    reason: 'move' | 'move-hidden';
  } | null>(null);
  const moveTo = (projectId: string | null) => {
    if (projectId === chat.projectId || shown.status !== 'known' || shown.mode === null) return;
    const target = projectId === null ? undefined : projects.data?.find((p) => p.id === projectId);
    if (shown.mode === 'auto' && target) {
      const unwarnedNoGit = !target.inGitRepo && acknowledged[target.id] !== true;
      if (unwarnedNoGit || !chip.showChip) {
        setMoveAsk({ chatId: chat.id, project: target, reason: unwarnedNoGit ? 'move' : 'move-hidden' });
        return;
      }
    }
    move.mutate({
      chatId: chat.id,
      projectId,
      expectedEditMode: shown.mode,
      ...(shown.mode === 'auto' && target ? { expectedInGitRepo: target.inGitRepo } : {}),
    });
  };

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
      forgetEditMode(chat.id);
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
            <MenuSubTrigger icon={<FolderInput size={15} />} disabled={shown.status !== 'known'}>
              Move to project
            </MenuSubTrigger>
            <MenuSubContent className="max-w-72">
              <MenuRadioGroup
                value={chat.projectId ?? NO_PROJECT}
                onValueChange={(value) => moveTo(value === NO_PROJECT ? null : value)}
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
          <MenuItem
            icon={chat.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            disabled={streaming || archive.isPending}
            onSelect={() => archive.mutate(!chat.archived)}
          >
            {chat.archived ? 'Unarchive' : 'Archive'}
          </MenuItem>
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
      <NoGitDialog
        open={moveAsk !== null}
        onOpenChange={(open) => {
          if (!open) setMoveAsk(null);
        }}
        projectName={moveAsk?.project.name ?? ''}
        reason={moveAsk?.reason ?? 'move'}
        returnFocusRef={triggerRef}
        // The dialog only opens for a chat shown in Auto, so both choices expect Auto.
        onReview={() => {
          if (moveAsk) {
            const { chatId, project } = moveAsk;
            move.mutate({ chatId, projectId: project.id, editMode: 'review', expectedEditMode: 'auto' });
          }
          setMoveAsk(null);
        }}
        onAuto={() => {
          if (moveAsk) {
            const { chatId, project, reason } = moveAsk;
            // Only the no-Git question is remembered per project; the hidden-Auto one asks on every such move.
            if (reason === 'move') acknowledge(project.id);
            move.mutate({
              chatId,
              projectId: project.id,
              expectedEditMode: 'auto',
              expectedInGitRepo: project.inGitRepo,
            });
          }
          setMoveAsk(null);
        }}
      />
      <Dialog
        open={moveError !== null}
        onOpenChange={(open) => {
          if (!open) setMoveError(null);
        }}
      >
        <DialogContent
          title="Couldn't move this chat"
          description={moveError}
          returnFocusRef={triggerRef}
          data-testid="move-error-dialog"
          footer={
            <Button variant="primary" onClick={() => setMoveError(null)}>
              OK
            </Button>
          }
        />
      </Dialog>
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
