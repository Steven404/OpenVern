import * as RadixPopover from '@radix-ui/react-popover';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import { cx } from './cx';

export const Popover = RadixPopover.Root;
/** Use with `asChild` around the element that toggles the popover. */
export const PopoverTrigger = RadixPopover.Trigger;
/** Optional: positions the popover against an element other than the trigger. */
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

/** Floating panel in a portal. Has no padding of its own: add e.g. `className="p-3"`. */
export const PopoverContent = forwardRef<
  ElementRef<typeof RadixPopover.Content>,
  ComponentPropsWithoutRef<typeof RadixPopover.Content>
>(function PopoverContent({ className, sideOffset = 8, align = 'start', ...props }, ref) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        className={cx(
          'z-50 max-h-(--radix-popover-content-available-height) max-w-(--radix-popover-content-available-width) overflow-auto rounded-[14px] border border-border-control bg-surface text-text shadow-2xl',
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
});
