import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cx } from './cx';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** Shared by `Button` and `IconButton`. */
export const buttonBase =
  'inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap font-medium disabled:cursor-not-allowed disabled:opacity-50';

const variantClass: Record<ButtonVariant, string> = {
  primary: 'border border-transparent bg-accent text-bg hover:brightness-110',
  ghost: 'border border-transparent bg-transparent text-text-secondary hover:bg-overlay-ghost hover:text-text',
  outline:
    'border border-border-control bg-surface-raised text-text hover:border-border-hover hover:bg-surface-raised-hover',
  danger: 'border border-transparent bg-danger text-bg hover:brightness-110',
};

/** Variant look for icon-only buttons (ghost is muted instead of secondary). */
export const iconVariantClass: Record<ButtonVariant, string> = {
  ...variantClass,
  ghost: 'border border-transparent bg-transparent text-text-muted hover:bg-overlay-ghost hover:text-text',
};

const sizeClass: Record<ButtonSize, string> = {
  sm: 'min-h-8 gap-1.5 rounded-[10px] px-3 text-[13px]',
  md: 'min-h-10 gap-2 rounded-[10px] px-4 text-sm',
  lg: 'min-h-11 gap-2 rounded-[12px] px-4 text-[15px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Default `outline`. `danger` is for destructive confirms. */
  variant?: ButtonVariant;
  /** Default `md`. */
  size?: ButtonSize;
  /** Shows a spinner, sets `aria-busy` and disables the button. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', loading = false, disabled, className, type = 'button', children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonBase, variantClass[variant], sizeClass[size], className)}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});
