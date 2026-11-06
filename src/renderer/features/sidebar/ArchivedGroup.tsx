import type { ChatSummary } from '@shared/types';
import { useEffect, useId, useState } from 'react';
import { ChatLink } from './ChatLink';
import { ChevronIcon } from './icons';

/**
 * Open state for an `ArchivedGroup`: starts collapsed and expands when the chat on screen is one of `chats`.
 * Lives in the owner (the sidebar or a project row) so it survives the group being unmounted, and a manual
 * collapse sticks until a different archived chat is opened.
 */
export function useArchivedGroupOpen(chats: ChatSummary[], currentChatId: string | undefined) {
  const [open, setOpen] = useState(false);
  const currentArchivedId = chats.find((c) => c.id === currentChatId)?.id ?? null;
  useEffect(() => {
    if (currentArchivedId) setOpen(true);
  }, [currentArchivedId]);
  return [open, setOpen] as const;
}

export interface ArchivedGroupProps {
  /** Archived chats, newest first. Nothing renders when empty. */
  chats: ChatSummary[];
  currentChatId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The collapsible "Archived N" toggle and its chat links, used in "Chats" and inside each project. */
export function ArchivedGroup({ chats, currentChatId, open, onOpenChange }: ArchivedGroupProps) {
  const listId = useId();
  if (chats.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => onOpenChange(!open)}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-[9px] px-2 text-left text-sm font-medium text-text hover:bg-overlay-row"
      >
        <ChevronIcon
          className="shrink-0 text-text-faint transition-transform duration-150 ease-in-out"
          style={{ transform: `rotate(${open ? 90 : 0}deg)` }}
        />
        <span className="flex-1 truncate">Archived</span>
        <span className="font-mono text-[11px] text-text-faint">{chats.length}</span>
      </button>
      {open ? (
        <ul id={listId} className="m-0 flex list-none flex-col gap-px p-0">
          {chats.map((chat) => (
            <li key={chat.id}>
              <ChatLink chat={chat} current={chat.id === currentChatId} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
