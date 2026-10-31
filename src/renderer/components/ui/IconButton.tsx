import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { type ButtonVariant, buttonBase, iconVariantClass } from './Button';
import { cx } from './cx';

export type IconButtonSize = 'sm' | 'md' | 'lg';

const sizeClass: Record<IconButtonSize, string> = {
  sm: 'size-7 rounded-[8px]',
  md: 'size-9 rounded-[10px]',
  lg: 'size-10 rounded-[10px]',
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Required: icon-only buttons need an accessible name. */
  'aria-label': string;
  /** Native tooltip text (`title`). */
  tooltip?: string;
  /** Default `ghost`. */
  variant?: ButtonVariant;
  /** 28 / 36 / 40 px squares. Default `md`. */
  size?: IconButtonSize;
}

/** Square icon-only button; pass the icon (e.g. a lucide icon) as `children`. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', tooltip, className, type = 'button', children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={tooltip}
      className={cx(buttonBase, iconVariantClass[variant], sizeClass[size], className)}
      {...props}
    >
      {children}
    </button>
  );
});
