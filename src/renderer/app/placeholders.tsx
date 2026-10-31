// Local stand-ins for S7's screens (plan "S6 ↔ S7 seams"). Same names and props as the real components, so the
// orchestrator only swaps the imports in `ChatScreen.tsx` / `App.tsx` when S7 lands:
//   NewChatScreen     → `@renderer/features/new-chat`     (no props; reads `?project=`)
//   Conversation      → `@renderer/features/conversation` (`{ chatId: Id }`)
//   ReplyComposer     → `@renderer/features/composer`     (`{ chat: ChatSummary }`)

import type { ChatSummary, Id } from '@shared/types';

export function NewChatScreen() {
  return (
    <div
      data-testid="new-chat-placeholder"
      className="flex flex-1 items-center justify-center px-6 pt-12 pb-[72px] text-center"
    >
      <h1 className="font-display text-[44px] leading-[1.1] font-bold tracking-[-0.03em] text-text">
        What are we building<span className="text-accent">?</span>
      </h1>
    </div>
  );
}

export function Conversation({ chatId }: { chatId: Id }) {
  return (
    <section
      aria-label="Conversation"
      data-testid="conversation-placeholder"
      className="min-h-0 flex-1 overflow-y-auto px-6 pt-10 pb-6 text-sm text-text-faint"
    >
      <p className="mx-auto max-w-(--width-conversation)">Conversation placeholder · {chatId}</p>
    </section>
  );
}

export function ReplyComposer({ chat }: { chat: ChatSummary }) {
  return (
    <div data-testid="composer-placeholder" className="px-6 pt-2 pb-5">
      <div className="mx-auto max-w-(--width-conversation) rounded-[18px] border border-border-control bg-surface px-[18px] py-3.5 text-[15.5px] text-text-faint">
        Reply to harness… <span className="sr-only">({chat.title})</span>
      </div>
    </div>
  );
}
