import type { HTMLAttributes } from 'react';
import { cx } from './cx';

/** Keyboard hint, e.g. `<Kbd>Ctrl N</Kbd>` or `<Kbd>⌘ N</Kbd>` on macOS (see `modKeyLabel`). */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cx('rounded-[5px] bg-overlay-tonal px-1.5 py-0.5 font-mono text-[11px] text-text-muted', className)}
      {...props}
    />
  );
}
