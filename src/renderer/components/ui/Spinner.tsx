import { cx } from './cx';

export interface SpinnerProps {
  /** Pixel size (default 16). */
  size?: number;
  className?: string;
  /** Accessible label; omit when a nearby element already announces the busy state. */
  label?: string;
}

/** Small ring spinner drawn in `currentColor`. Slows to a gentle pulse under `prefers-reduced-motion`. */
export function Spinner({ size = 16, className, label }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cx('shrink-0 animate-spin motion-reduce:animate-pulse', className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid="spinner"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
