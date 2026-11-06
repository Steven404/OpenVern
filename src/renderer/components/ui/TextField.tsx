import { forwardRef, type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { cx } from './cx';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: ReactNode;
  /** Muted help text below the input. */
  hint?: ReactNode;
  /** Inline error in danger colour; also sets `aria-invalid` and links via `aria-describedby`. */
  error?: ReactNode;
  /** Element inside the right edge of the input, e.g. a show/hide `IconButton` (size `sm`). */
  trailing?: ReactNode;
  /** Applied to the outer wrapper. */
  className?: string;
  /** Applied to the `<input>`. */
  inputClassName?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, trailing, className, inputClassName, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null, props['aria-describedby']]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className="text-[13px] font-medium text-text-secondary">
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          {...props}
          aria-describedby={describedBy || undefined}
          className={cx(
            'h-11 w-full rounded-[10px] border bg-surface px-3.5 text-[14.5px] text-text transition-colors duration-150 placeholder:text-text-faint hover:border-border-hover focus:border-border-focus disabled:cursor-not-allowed disabled:opacity-50',
            error ? 'border-danger hover:border-danger focus:border-danger' : 'border-border-control',
            trailing ? 'pr-11' : null,
            inputClassName,
          )}
        />
        {trailing ? <div className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</div> : null}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-[13px] text-text-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
