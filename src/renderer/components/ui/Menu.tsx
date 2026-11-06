import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef, type ReactNode } from 'react';
import { cx } from './cx';

export const Menu = DropdownMenu.Root;
/** Use with `asChild` around a `Button` / `IconButton`. */
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuSub = DropdownMenu.Sub;
export const MenuRadioGroup = DropdownMenu.RadioGroup;

const panel =
  'z-50 min-w-48 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto rounded-[10px] border border-border-control bg-surface p-1 text-text shadow-2xl';

const itemBase =
  'relative flex min-h-9 cursor-pointer select-none items-center gap-2.5 rounded-[6px] px-2.5 text-[13.5px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

const itemTone = 'text-text-secondary data-[highlighted]:bg-overlay-ghost data-[highlighted]:text-text';
const dangerTone = 'text-danger data-[highlighted]:bg-overlay-ghost';

export const MenuContent = forwardRef<
  ElementRef<typeof DropdownMenu.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Content>
>(function MenuContent({ className, sideOffset = 6, align = 'end', ...props }, ref) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        className={cx(panel, className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
});

export interface MenuItemProps extends ComponentPropsWithoutRef<typeof DropdownMenu.Item> {
  /** Leading icon (e.g. a 16px lucide icon). */
  icon?: ReactNode;
  /** Destructive styling (danger colour). */
  danger?: boolean;
}

export const MenuItem = forwardRef<ElementRef<typeof DropdownMenu.Item>, MenuItemProps>(function MenuItem(
  { icon, danger, className, children, ...props },
  ref,
) {
  return (
    <DropdownMenu.Item ref={ref} className={cx(itemBase, danger ? dangerTone : itemTone, className)} {...props}>
      {icon ? (
        <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {children}
    </DropdownMenu.Item>
  );
});

const checkSlot = (
  <span aria-hidden="true" className="ml-auto inline-flex size-4 shrink-0 items-center justify-center text-accent">
    <DropdownMenu.ItemIndicator>
      <Check size={14} strokeWidth={2.4} />
    </DropdownMenu.ItemIndicator>
  </span>
);

/** Toggle item with a trailing check when `checked`. Selecting it closes the menu unless `onSelect` calls `preventDefault()`. */
export const MenuCheckboxItem = forwardRef<
  ElementRef<typeof DropdownMenu.CheckboxItem>,
  ComponentPropsWithoutRef<typeof DropdownMenu.CheckboxItem> & { icon?: ReactNode }
>(function MenuCheckboxItem({ icon, className, children, ...props }, ref) {
  return (
    <DropdownMenu.CheckboxItem ref={ref} className={cx(itemBase, itemTone, className)} {...props}>
      {icon ? (
        <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {children}
      {checkSlot}
    </DropdownMenu.CheckboxItem>
  );
});

/** Single-choice item for use inside `MenuRadioGroup value onValueChange` ("current" selections); trailing check on the chosen one. */
export const MenuRadioItem = forwardRef<
  ElementRef<typeof DropdownMenu.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownMenu.RadioItem> & { icon?: ReactNode }
>(function MenuRadioItem({ icon, className, children, ...props }, ref) {
  return (
    <DropdownMenu.RadioItem ref={ref} className={cx(itemBase, itemTone, className)} {...props}>
      {icon ? (
        <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {children}
      {checkSlot}
    </DropdownMenu.RadioItem>
  );
});

export const MenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenu.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Separator>
>(function MenuSeparator({ className, ...props }, ref) {
  return <DropdownMenu.Separator ref={ref} className={cx('my-1 h-px bg-border-control', className)} {...props} />;
});

export const MenuLabel = forwardRef<
  ElementRef<typeof DropdownMenu.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Label>
>(function MenuLabel({ className, ...props }, ref) {
  return (
    <DropdownMenu.Label
      ref={ref}
      className={cx(
        'px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase',
        className,
      )}
      {...props}
    />
  );
});

export interface MenuSubTriggerProps extends ComponentPropsWithoutRef<typeof DropdownMenu.SubTrigger> {
  icon?: ReactNode;
}

export const MenuSubTrigger = forwardRef<ElementRef<typeof DropdownMenu.SubTrigger>, MenuSubTriggerProps>(
  function MenuSubTrigger({ icon, className, children, ...props }, ref) {
    return (
      <DropdownMenu.SubTrigger
        ref={ref}
        className={cx(itemBase, itemTone, 'data-[state=open]:bg-overlay-ghost', className)}
        {...props}
      >
        {icon ? (
          <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center">
            {icon}
          </span>
        ) : null}
        {children}
        <ChevronRight aria-hidden="true" size={14} className="ml-auto text-text-faint" />
      </DropdownMenu.SubTrigger>
    );
  },
);

export const MenuSubContent = forwardRef<
  ElementRef<typeof DropdownMenu.SubContent>,
  ComponentPropsWithoutRef<typeof DropdownMenu.SubContent>
>(function MenuSubContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        ref={ref}
        sideOffset={sideOffset}
        className={cx(panel, 'max-h-(--radix-dropdown-menu-content-available-height)', className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
});
