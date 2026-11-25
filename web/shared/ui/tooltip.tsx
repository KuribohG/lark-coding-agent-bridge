import type { ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-tooltip';

export const TooltipProvider = Primitive.Provider;

/** A short label for a control that shows only an icon, with its keyboard shortcut when it has one. */
export function Tooltip({ label, shortcut, side = 'bottom', children }: {
  label: ReactNode; shortcut?: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode;
}) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content side={side} sideOffset={6} collisionPadding={8}
          className="z-50 flex items-center gap-2 rounded-md bg-foreground px-2 py-1 text-[12px] text-background shadow-pop animate-pop">
          {label}
          {shortcut && <kbd className="font-sans text-[11px] opacity-60">{shortcut}</kbd>}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
