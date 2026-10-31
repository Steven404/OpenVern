import type { HTMLAttributes } from 'react';
import { cx } from './cx';

/** Keyboard hint, e.g. `<Kbd>Ctrl N</Kbd>`. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cx(
        'rounded-[6px] border border-border-control px-1.5 py-px font-mono text-[11px] font-normal text-text-muted',
        className,
      )}
      {...props}
    />
  );
}
