import type { UserMessage } from '@shared/types';
import { memo } from 'react';
import { SentAttachments } from '../composer/AttachmentChips';

/** D10: right-aligned bubble; attachments above the text, whitespace preserved. */
export const UserBubble = memo(function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div
      data-testid="user-bubble"
      className="max-w-[78%] self-end rounded-[18px_18px_6px_18px] border border-border-bubble bg-bubble px-4 py-3 text-[15.5px] text-text"
    >
      <SentAttachments attachments={message.attachments} />
      {message.text ? <div className="break-words whitespace-pre-wrap">{message.text}</div> : null}
    </div>
  );
});
