import type { ChatSummary } from '@shared/types';
import { useCallback } from 'react';
import { selectRun, useRunsStore } from '../../stores/runs';
import { Composer, type ComposerSendInput } from './Composer';
import { useRunDeps } from './queries';

export interface ReplyComposerProps {
  chat: ChatSummary;
}

/** Composer at the bottom of a chat (reply variant). Sends and stops through the `runs` store. */
export function ReplyComposer({ chat }: ReplyComposerProps) {
  // Re-key per chat so draft text, attachments and the model choice never leak between chats.
  return <ReplyComposerInner key={chat.id} chat={chat} />;
}

function ReplyComposerInner({ chat }: ReplyComposerProps) {
  const deps = useRunDeps();
  const remembered = useRunsStore((s) => s.chatModels[chat.id]);
  const run = useRunsStore(selectRun(chat.id));
  const send = useRunsStore((s) => s.send);
  const stop = useRunsStore((s) => s.stop);
  const setChatModel = useRunsStore((s) => s.setChatModel);
  const model = remembered ?? chat.model;

  const onSend = useCallback(
    ({ text, attachments }: ComposerSendInput) => {
      void send(deps, chat.id, { text, attachments, model });
    },
    [send, deps, chat.id, model],
  );

  return (
    <div className="px-6 pt-2 pb-5">
      <div className="mx-auto max-w-[760px]">
        <Composer
          variant="reply"
          model={model}
          onModelChange={(id) => setChatModel(chat.id, id)}
          projectId={chat.projectId}
          running={run?.status === 'running'}
          busy={run?.status === 'settling'}
          onStop={() => stop(chat.id)}
          onSend={onSend}
          autoFocus
          sinkKey={chat.id}
        />
      </div>
    </div>
  );
}
