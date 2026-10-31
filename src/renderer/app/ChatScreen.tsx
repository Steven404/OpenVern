// `#/chat/:id` — ChatHeader (S6) + Conversation (S7) + ReplyComposer (S7).
// S7 swap: replace the `./placeholders` import below with
//   import { Conversation } from '@renderer/features/conversation';
//   import { ReplyComposer } from '@renderer/features/composer';

import { Button } from '@renderer/components/ui';
import { ChatHeader } from '@renderer/features/chat-header';
import { ApiError } from '@renderer/lib/api-client';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { paths } from '@renderer/lib/routes';
import type { ChatSummary } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { Conversation, ReplyComposer } from './placeholders';
import { useChats } from './queries';

/** The chats list is patched live by `chat_updated`; `chat(id)` is the fallback before the list has the chat. */
function newest(listed: ChatSummary | undefined, loaded: ChatSummary | undefined): ChatSummary | undefined {
  if (!listed || !loaded) return listed ?? loaded;
  return loaded.updatedAt > listed.updatedAt ? loaded : listed;
}

export function ChatScreen() {
  const { id = '' } = useParams();
  const api = useApiClient();
  const navigate = useNavigate();
  const chatQuery = useQuery({ queryKey: queryKeys.chat(id), queryFn: () => api.getChat(id), enabled: id !== '' });
  const chats = useChats();
  const summary = newest(
    chats.data?.find((c) => c.id === id),
    chatQuery.data,
  );

  if (!summary) {
    if (chatQuery.error instanceof ApiError && chatQuery.error.info.code === 'not_found') {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-text-muted">This chat doesn't exist or was deleted.</p>
          <Button variant="outline" onClick={() => navigate(paths.newChat())}>
            Start a new chat
          </Button>
        </div>
      );
    }
    return <div className="flex-1" aria-busy={chatQuery.isPending} />;
  }

  return (
    <>
      <ChatHeader chat={summary} />
      <div className="flex min-h-0 flex-1 flex-col">
        <Conversation chatId={id} />
      </div>
      <ReplyComposer chat={summary} />
    </>
  );
}
