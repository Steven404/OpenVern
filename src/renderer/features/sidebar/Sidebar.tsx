import { useChats, useCurrentChatId, useNewChatPath, useProjects } from '@renderer/app/queries';
import { Button, cx, IconButton, Kbd } from '@renderer/components/ui';
import { useUiStore } from '@renderer/stores/ui';
import { APP_NAME } from '@shared/constants';
import type { ChatSummary } from '@shared/types';
import { useEffect, useMemo } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { ChatLink } from './ChatLink';
import { GearIcon, PanelIcon, PlusIcon } from './icons';
import { ProjectRow } from './ProjectRow';

export const SIDEBAR_COLLAPSE_BUTTON_ID = 'sidebar-collapse';

const sectionLabel = 'm-0 font-mono text-[11px] font-medium tracking-[0.12em] text-text-muted uppercase';

const byNewest = (a: ChatSummary, b: ChatSummary) => b.updatedAt.localeCompare(a.updatedAt);

/** D1–D7 plus the "CHATS" section. `onCollapse` hides the sidebar (desktop collapse, or closing the overlay). */
export function Sidebar({ onCollapse, className }: { onCollapse: () => void; className?: string }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const chats = useChats();
  const currentChatId = useCurrentChatId();
  const newChatPath = useNewChatPath();
  const onNewChatScreen = useMatch('/new') !== null;
  const openSettings = useUiStore((s) => s.openSettings);
  const openNewProject = useUiStore((s) => s.openNewProject);
  const expandProject = useUiStore((s) => s.expandProject);

  const { byProject, loose } = useMemo(() => {
    const byProject = new Map<string, ChatSummary[]>();
    const loose: ChatSummary[] = [];
    for (const chat of [...(chats.data ?? [])].sort(byNewest)) {
      if (chat.projectId === null) loose.push(chat);
      else byProject.set(chat.projectId, [...(byProject.get(chat.projectId) ?? []), chat]);
    }
    return { byProject, loose };
  }, [chats.data]);

  // The project of the chat on screen expands when you arrive at (or move) the chat; manual collapse sticks after that.
  const currentProjectId = chats.data?.find((c) => c.id === currentChatId)?.projectId ?? null;
  useEffect(() => {
    if (currentProjectId) expandProject(currentProjectId);
  }, [currentProjectId, expandProject]);

  return (
    <aside
      aria-label="Sidebar"
      className={cx(
        'flex h-full min-h-0 w-(--width-sidebar) shrink-0 flex-col border-r border-border bg-sidebar',
        className,
      )}
    >
      <div className="flex items-center justify-between pt-[18px] pr-4 pb-3.5 pl-5">
        <span className="font-display text-[21px] font-bold tracking-[-0.02em] text-text">
          {APP_NAME}
          <span className="text-accent">.</span>
        </span>
        <IconButton id={SIDEBAR_COLLAPSE_BUTTON_ID} aria-label="Collapse sidebar" onClick={onCollapse}>
          <PanelIcon />
        </IconButton>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          aria-current={onNewChatScreen ? 'page' : undefined}
          onClick={() => navigate(newChatPath)}
          className={cx(
            'flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-[12px] border px-3 text-[15px] font-medium text-text',
            onNewChatScreen
              ? 'border-border-hover bg-surface-raised-active'
              : 'border-border-control bg-surface-raised hover:border-border-hover hover:bg-surface-raised-hover',
          )}
        >
          <PlusIcon />
          <span className="flex-1 text-left">New chat</span>
          <Kbd>Ctrl N</Kbd>
        </button>
      </div>

      <nav aria-label="Projects and chats" className="min-h-0 flex-1 overflow-y-auto px-3 pt-[18px] pb-3">
        <div className="flex min-h-7 items-center justify-between px-2 pb-2 box-content">
          <h2 className={sectionLabel}>Projects</h2>
          <IconButton size="sm" aria-label="New project" onClick={openNewProject}>
            <PlusIcon size={15} />
          </IconButton>
        </div>

        {projects.isError ? (
          <div className="flex flex-col items-start gap-1 px-2 text-[13px] text-text-faint">
            Couldn't load projects.
            <Button size="sm" variant="ghost" onClick={() => projects.refetch()}>
              Try again
            </Button>
          </div>
        ) : projects.data?.length === 0 ? (
          <div className="flex flex-col items-start gap-1 px-2">
            <p className="m-0 py-1 text-[13px] text-text-faint">No projects yet</p>
            <Button size="sm" variant="ghost" onClick={openNewProject} className="-ml-1">
              Add project
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {(projects.data ?? []).map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                chats={byProject.get(project.id) ?? []}
                currentChatId={currentChatId}
              />
            ))}
          </div>
        )}

        {loose.length > 0 ? (
          <section aria-labelledby="sidebar-chats" className="pt-[18px]">
            <div className="flex min-h-7 items-center px-2 pb-2 box-content">
              <h2 id="sidebar-chats" className={sectionLabel}>
                Chats
              </h2>
            </div>
            <ul className="m-0 flex list-none flex-col gap-px p-0">
              {loose.map((chat) => (
                <li key={chat.id}>
                  <ChatLink chat={chat} current={chat.id === currentChatId} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </nav>

      <div className="flex items-center gap-1 border-t border-border px-3 pt-2.5 pb-3.5">
        <button
          type="button"
          onClick={openSettings}
          className="inline-flex min-h-10 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 text-sm text-text-secondary hover:bg-overlay-ghost hover:text-text"
        >
          <GearIcon />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
