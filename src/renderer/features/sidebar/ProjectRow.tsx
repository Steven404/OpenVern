import { ProjectMenu } from '@renderer/features/projects';
import { useUiStore } from '@renderer/stores/ui';
import type { ChatSummary, ProjectListItem } from '@shared/types';
import { useId, useState } from 'react';
import { ArchivedGroup, useArchivedGroupOpen } from './ArchivedGroup';
import { ChatLink } from './ChatLink';
import { ChevronIcon, FolderIcon } from './icons';

export interface ProjectRowProps {
  project: ProjectListItem;
  /** This project's active (unarchived) chats, newest first. */
  chats: ChatSummary[];
  /** This project's archived chats, newest first, listed under its "Archived" toggle. */
  archivedChats?: ChatSummary[];
  /** The count shown on the row (active chats). `undefined` while it isn't known yet: the row shows no count. */
  chatCount: number | undefined;
  currentChatId: string | undefined;
}

/**
 * D5 + D6: expandable project row with its chat links, then its "Archived" toggle, and the "…" menu that replaces
 * the count on hover.
 */
export function ProjectRow({ project, chats, archivedChats = [], chatCount, currentChatId }: ProjectRowProps) {
  const expanded = useUiStore((s) => s.expandedProjects[project.id] === true);
  const toggle = useUiStore((s) => s.toggleProject);
  const [menuOpen, setMenuOpen] = useState(false);
  const listId = useId();
  // Starts collapsed; expands when the chat on screen is one of this project's archived chats.
  const [archivedOpen, setArchivedOpen] = useArchivedGroupOpen(archivedChats, currentChatId);

  return (
    <div>
      <div className="group relative" data-menu-open={menuOpen ? '' : undefined}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          onClick={() => toggle(project.id)}
          className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-[7px] px-2 text-left text-sm font-medium text-text hover:bg-overlay-row"
        >
          <ChevronIcon
            className="shrink-0 text-text-faint transition-transform duration-150 ease-in-out"
            style={{ transform: `rotate(${expanded ? 90 : 0}deg)` }}
          />
          <FolderIcon className="shrink-0 text-accent-2" />
          <span className="flex-1 truncate">{project.name}</span>
          {chatCount !== undefined ? (
            <span className="font-mono text-[11px] text-text-faint group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible">
              {chatCount}
            </span>
          ) : null}
        </button>
        <ProjectMenu project={project} onMenuOpenChange={setMenuOpen} />
      </div>
      {expanded ? (
        <ul id={listId} className="mt-0.5 mb-1.5 flex list-none flex-col gap-px p-0 pl-[30px]">
          {chats.length === 0 && archivedChats.length === 0 ? (
            <li className="px-2.5 py-[7px] text-[13px] text-text-faint">No chats yet</li>
          ) : (
            chats.map((chat) => (
              <li key={chat.id}>
                <ChatLink chat={chat} current={chat.id === currentChatId} />
              </li>
            ))
          )}
          {archivedChats.length > 0 ? (
            <li>
              <ArchivedGroup
                chats={archivedChats}
                currentChatId={currentChatId}
                open={archivedOpen}
                onOpenChange={setArchivedOpen}
              />
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
