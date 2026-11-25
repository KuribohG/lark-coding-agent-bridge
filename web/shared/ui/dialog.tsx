import type { ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../cn';

export function Dialog({ open, onOpenChange, title, description, children, className, hideClose }: {
  open: boolean; onOpenChange(open: boolean): void; title: string; description?: string; children: ReactNode;
  className?: string; hideClose?: boolean;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px] animate-fade-in" />
        <Primitive.Content
          className={cn('fixed left-1/2 top-[18vh] z-50 w-[min(92vw,460px)] -translate-x-1/2 rounded-xl border bg-popover p-5 text-popover-foreground shadow-pop animate-pop', className)}>
          <Primitive.Title className={cn('text-[15px] font-semibold', hideClose && 'sr-only')}>{title}</Primitive.Title>
          {description
            ? <Primitive.Description className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</Primitive.Description>
            : <Primitive.Description className="sr-only">{title}</Primitive.Description>}
          {children}
          {!hideClose && (
            <Primitive.Close aria-label="关闭"
              className="absolute right-3.5 top-3.5 rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-foreground">
              <X className="size-4" />
            </Primitive.Close>
          )}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
