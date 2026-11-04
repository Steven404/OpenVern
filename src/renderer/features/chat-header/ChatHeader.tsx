import { useProjects } from '@renderer/app/queries';
import { APP_NAME } from '@shared/constants';
import type { ChatSummary } from '@shared/types';
import { useEffect } from 'react';
import { RightPanelToggle } from '../right-panel';
import { ChatOptionsMenu } from './ChatOptionsMenu';

/** D8 + D9: breadcrumb (`PROJECT /`, `Chats /` or `Archived /`), chat title, options menu. Also owns `document.title`. */
export function ChatHeader({ chat }: { chat: ChatSummary }) {
  const projects = useProjects();
  const crumb = chat.projectId
    ? projects.data?.find((p) => p.id === chat.projectId)?.name
    : projects.isPending
      ? undefined
      : chat.archived
        ? 'Archived'
        : 'Chats';

  useEffect(() => {
    document.title = `${chat.title} — ${APP_NAME}`;
    return () => {
      document.title = APP_NAME;
    };
  }, [chat.title]);

  return (
    <header className="flex min-h-(--height-header) items-center gap-3 border-b border-border-header py-3 pr-3 pl-6 group-data-[sidebar-hidden]:pl-16">
      {crumb ? (
        <span className="max-w-[40%] shrink-0 truncate font-mono text-xs tracking-[0.08em] text-text-muted uppercase">
          {crumb} /
        </span>
      ) : null}
      <h1 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold text-text" title={chat.title}>
        {chat.title}
      </h1>
      <ChatOptionsMenu chat={chat} />
      <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
      <RightPanelToggle />
    </header>
  );
}
