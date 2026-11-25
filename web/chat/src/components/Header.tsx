import { useEffect, useRef, useState } from 'react';
import { Ellipsis, PanelLeft, Pencil, Pin, PinOff, SquarePen, Trash2, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@shared/cn';
import { Button } from '@shared/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@shared/ui/menu';
import { Tooltip } from '@shared/ui/tooltip';
import { modKey } from '@/lib/format';
import { setSidebar, useSidebar } from '@/lib/settings';
import type { Conversation } from '@/lib/types';
import { useSession, useSessionApi } from '@/lib/use-session';

const report = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));

/** The bar above the conversation: what it is called, whether it is running, and what can be done with it. */
export function Header({ panel, onPanel, onRemove }: { panel: boolean; onPanel(): void; onRemove(conversation: Conversation): void }) {
  const session = useSessionApi();
  const sidebar = useSidebar();
  const id = useSession(state => state.conversationId);
  const conversation = useSession(state => state.conversations.find(known => known.id === state.conversationId));
  const workflows = useSession(state => Boolean(state.meta?.workflows));
  const running = useSession(() => session.runningId() !== undefined);
  const [renaming, setRenaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) input.current?.select(); }, [renaming]);
  const title = conversation?.title;
  useEffect(() => { document.title = title ? `${title} · Bridge` : 'Bridge'; }, [title]);

  const commit = () => {
    const title = input.current?.value.trim();
    setRenaming(false);
    if (id && title && title !== conversation?.title) session.rename(id, title).catch(report);
  };

  return (
    <header className="flex h-13 shrink-0 items-center gap-1.5 border-b px-3">
      {!sidebar && (
        <>
          <Tooltip label="展开侧栏" shortcut={`${modKey} B`}>
            <Button variant="ghost" size="icon" aria-label="展开侧栏" onClick={() => setSidebar(true)}><PanelLeft /></Button>
          </Tooltip>
          <Tooltip label="新对话" shortcut={`${modKey} ⇧ O`}>
            <Button variant="ghost" size="icon" aria-label="新对话" onClick={() => session.open(undefined)}><SquarePen /></Button>
          </Tooltip>
        </>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5">
        {renaming && conversation ? (
          <input ref={input} defaultValue={conversation.title} aria-label="对话名称" onBlur={commit}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit(); if (event.key === 'Escape') setRenaming(false); }}
            className="h-8 w-full max-w-md rounded-lg border border-primary/60 bg-card px-2.5 text-[14px] font-medium outline-none ring-2 ring-ring/40" />
        ) : (
          <h1 className={cn('truncate text-[14.5px] font-semibold', !conversation && 'text-muted-foreground')}
            onDoubleClick={() => conversation && setRenaming(true)} title={conversation ? '双击重命名' : undefined}>
            {conversation?.title ?? '新对话'}
          </h1>
        )}
        {running && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-2 py-0.5 text-[11.5px] font-medium text-accent-foreground" role="status">
            <span className="size-1.5 rounded-full bg-primary animate-pulse-dot" />运行中
          </span>
        )}
      </div>
      {workflows && (
        <Tooltip label={panel ? '收起工作流' : '查看这个对话的工作流'}>
          <Button variant="ghost" size="md" aria-pressed={panel} onClick={onPanel} className={cn('px-2.5', panel && 'bg-hover text-foreground')}>
            <Workflow />工作流
          </Button>
        </Tooltip>
      )}
      {conversation && (
        <Menu>
          <MenuTrigger asChild><Button variant="ghost" size="icon" aria-label="对话操作"><Ellipsis /></Button></MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>重命名</MenuItem>
            <MenuItem icon={conversation.pinned ? <PinOff /> : <Pin />} onSelect={() => session.pin(conversation.id, !conversation.pinned).catch(report)}>
              {conversation.pinned ? '取消置顶' : '置顶'}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 />} onSelect={() => onRemove(conversation)}>删除对话</MenuItem>
          </MenuContent>
        </Menu>
      )}
    </header>
  );
}
