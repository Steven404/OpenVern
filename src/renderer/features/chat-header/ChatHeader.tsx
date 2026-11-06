import { useProjects } from '@renderer/app/queries';
import { ContextUsageButton } from '@renderer/features/context-usage';
import { APP_NAME } from '@shared/constants';
import type { ChatSummary } from '@shared/types';
import { useEffect } from 'react';
import { RightPanelToggle } from '../right-panel';
import { ChatOptionsMenu } from './ChatOptionsMenu';

/**
 * D8 + D9: breadcrumb (`PROJECT /`, `PROJECT · ARCHIVED /`, `Chats /` or `Archived /`), chat title, options menu.
 * Also owns `document.title`.
 */
export function ChatHeader({ chat }: { chat: ChatSummary }) {
  const projects = useProjects();
  const projectName = chat.projectId ? projects.data?.find((p) => p.id === chat.projectId)?.name : undefined;
  const crumb = chat.projectId
    ? projectName && chat.archived
      ? `${projectName} · Archived`
      : projectName
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
      {crumb && projectName ? (
        // The project name truncates; the ` · Archived /` suffix never does.
        <span className="flex min-w-0 max-w-[40%] shrink-0 font-mono text-[13px] text-text-muted" title={crumb}>
          <span className="min-w-0 truncate">{projectName}</span>
          <span className="shrink-0 whitespace-pre">{chat.archived ? ' · Archived /' : ' /'}</span>
        </span>
      ) : crumb ? (
        <span className="max-w-[40%] shrink-0 truncate font-mono text-[13px] text-text-muted">{crumb} /</span>
      ) : null}
      <h1 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold text-text" title={chat.title}>
        {chat.title}
      </h1>
      <ChatOptionsMenu chat={chat} />
      <ContextUsageButton chat={chat} />
      <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
      <RightPanelToggle />
    </header>
  );
}
