import type { ComponentProps, ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-dropdown-menu';
import { cn } from '../cn';

export const Menu = Primitive.Root;
export const MenuTrigger = Primitive.Trigger;

export function MenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content sideOffset={sideOffset} collisionPadding={8}
        className={cn('z-50 min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-pop animate-pop', className)} {...props} />
    </Primitive.Portal>
  );
}

export function MenuItem({ className, danger, icon, children, ...props }: ComponentProps<typeof Primitive.Item> & { danger?: boolean; icon?: ReactNode }) {
  return (
    <Primitive.Item
      className={cn('flex cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-45 [&_svg]:size-[15px] [&_svg]:text-muted-foreground',
        danger && 'text-destructive [&_svg]:text-destructive', className)} {...props}>
      {icon}
      {children}
    </Primitive.Item>
  );
}

export function MenuSeparator() {
  return <Primitive.Separator className="mx-1 my-1 h-px bg-border" />;
}
