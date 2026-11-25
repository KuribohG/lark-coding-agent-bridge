import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-popover';
import { cn } from '../cn';

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;

/** A panel that hangs from what opened it and holds more than a list of commands. */
export function PopoverContent({ className, sideOffset = 8, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content sideOffset={sideOffset} collisionPadding={10}
        className={cn('z-50 rounded-xl border bg-popover text-popover-foreground shadow-pop outline-none animate-pop', className)} {...props} />
    </Primitive.Portal>
  );
}
