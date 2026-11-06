import { cx } from '@renderer/components/ui';
import { paths } from '@renderer/lib/routes';
import type { ChatSummary } from '@shared/types';
import { Link } from 'react-router';

/** D6: a chat link. The current chat gets `aria-current="page"` and the inset 2px accent bar. */
export function ChatLink({ chat, current }: { chat: ChatSummary; current: boolean }) {
  return (
    <Link
      to={paths.chat(chat.id)}
      title={chat.title}
      aria-current={current ? 'page' : undefined}
      className={cx(
        'block truncate px-2.5 py-[7px] text-[13.5px] no-underline',
        current
          ? 'rounded-[0_6px_6px_0] bg-overlay-current text-text shadow-[inset_2px_0_0_var(--color-accent)]'
          : 'rounded-[6px] text-text-chat hover:bg-overlay-row',
      )}
    >
      {chat.title}
    </Link>
  );
}
