import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Ellipsis, LoaderCircle, PanelLeftClose, Pencil, Pin, PinOff, Search, Settings, SquarePen, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@shared/cn';
import { Button } from '@shared/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@shared/ui/menu';
import { Tooltip } from '@shared/ui/tooltip';
import { baseName, groupConversations, modKey } from '@/lib/format';
import { closeDrawer, setSidebar } from '@/lib/settings';
import type { Link } from '@/lib/stream';
import type { Conversation } from '@/lib/types';
import { useSession, useSessionApi } from '@/lib/use-session';
import { Logo } from './Logo';

const report = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));

const LINK_TEXT: Record<Link, string> = { live: '已连接', connecting: '正在连接…', offline: '连接已断开，正在重试…', unauthorized: '链接已失效' };

const Row = memo(function Row({ conversation, current, onRemove }: { conversation: Conversation; current: boolean; onRemove(conversation: Conversation): void }) {
  const session = useSessionApi();
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) input.current?.select(); }, [renaming]);

  const commit = () => {
    const title = input.current?.value.trim();
    setRenaming(false);
    if (title && title !== conversation.title) session.rename(conversation.id, title).catch(report);
  };

  if (renaming) {
    return (
      <input ref={input} defaultValue={conversation.title} aria-label="对话名称" onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit(); if (event.key === 'Escape') setRenaming(false); }}
        className="h-8.5 w-full rounded-lg border border-primary/60 bg-card px-2.5 text-[13.5px] outline-none ring-2 ring-ring/40" />
    );
  }
  return (
    <div className={cn('group/row relative flex h-8.5 items-center rounded-lg text-[13.5px] transition-colors',
      current ? 'bg-accent text-accent-foreground' : 'text-foreground/85 hover:bg-hover')}>
      <button type="button" aria-current={current ? 'page' : undefined} title={conversation.title}
        onClick={() => { session.open(conversation.id); closeDrawer(); }} onDoubleClick={() => setRenaming(true)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2.5 pr-1 text-left">
        {conversation.activeRunId
          ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-label="运行中" />
          : conversation.pinned && <Pin className="size-3 shrink-0 text-subtle" aria-label="已置顶" />}
        <span className={cn('truncate', current && 'font-medium')}>{conversation.title}</span>
      </button>
      <Menu open={menu} onOpenChange={setMenu}>
        <MenuTrigger aria-label="更多操作"
          className={cn('mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:opacity-100',
            menu ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100')}>
          <Ellipsis className="size-4" />
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>重命名</MenuItem>
          <MenuItem icon={conversation.pinned ? <PinOff /> : <Pin />} onSelect={() => session.pin(conversation.id, !conversation.pinned).catch(report)}>
            {conversation.pinned ? '取消置顶' : '置顶'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 />} onSelect={() => onRemove(conversation)}>删除</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
});

/** The list of conversations, and the way to a new one. */
export function Sidebar({ onSettings, onSearch, onRemove }: { onSettings(): void; onSearch(): void; onRemove(conversation: Conversation): void }) {
  const session = useSessionApi();
  const conversations = useSession(state => state.conversations);
  const listed = useSession(state => state.listed);
  const current = useSession(state => state.conversationId);
  const link = useSession(state => state.link);
  const meta = useSession(state => state.meta);
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const shown = query ? conversations.filter(conversation => `${conversation.title}\n${conversation.preview}`.toLowerCase().includes(query)) : conversations;
    return groupConversations(shown);
  }, [conversations, filter]);

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r bg-sidebar" aria-label="对话列表">
      <div className="flex h-13 items-center gap-2.5 px-3.5">
        <Logo />
        <span className="text-[15px] font-semibold tracking-tight">Bridge</span>
        <span className="flex-1" />
        <Tooltip label="收起侧栏" shortcut={`${modKey} B`}>
          <Button variant="ghost" size="icon-sm" aria-label="收起侧栏" onClick={() => setSidebar(false)}><PanelLeftClose /></Button>
        </Tooltip>
      </div>
      <div className="space-y-1.5 px-2.5 pb-2">
        <button type="button" onClick={() => { session.open(undefined); closeDrawer(); }}
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-border-strong bg-card px-2.5 text-[13.5px] font-medium shadow-[0_1px_1px_oklch(0.2_0.02_265/4%)] hover:bg-muted">
          <SquarePen className="size-4 text-primary" />
          新对话
          <span className="flex-1" />
          <kbd className="font-sans text-[11px] font-normal text-subtle">{modKey} ⇧ O</kbd>
        </button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索对话" aria-label="搜索对话"
            onKeyDown={event => { if (event.key === 'Escape') setFilter(''); }}
            className="h-8 w-full rounded-lg bg-hover pl-8 pr-12 text-[13px] outline-none placeholder:text-subtle focus:ring-2 focus:ring-ring/40" />
          <button type="button" onClick={onSearch} tabIndex={-1} aria-label="打开命令面板"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 font-sans text-[11px] text-subtle hover:text-foreground">{modKey} K</button>
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {!listed && (
          <div className="space-y-2 px-1 pt-3" aria-hidden>
            {[70, 52, 84, 60].map(width => <div key={width} className="h-3.5 rounded-full bg-hover animate-pulse" style={{ width: `${width}%` }} />)}
          </div>
        )}
        {listed && groups.length === 0 && (
          <p className="px-2 pt-8 text-center text-[13px] leading-relaxed text-subtle">
            {filter ? '没有匹配的对话' : '还没有对话。\n发出第一条消息后，它会出现在这里。'.split('\n').map(line => <span key={line} className="block">{line}</span>)}
          </p>
        )}
        {groups.map(group => (
          <section key={group.label} className="pt-3">
            <h2 className="px-2.5 pb-1 text-[11.5px] font-medium text-subtle">{group.label}</h2>
            <div className="space-y-px">
              {group.conversations.map(conversation => (
                <Row key={conversation.id} conversation={conversation} current={conversation.id === current} onRemove={onRemove} />
              ))}
            </div>
          </section>
        ))}
      </nav>
      <div className="flex h-12 items-center gap-2 border-t px-3">
        <Tooltip label={LINK_TEXT[link]} side="top">
          <span className={cn('size-2 shrink-0 rounded-full', link === 'live' ? 'bg-success' : link === 'connecting' ? 'bg-warning animate-pulse' : 'bg-destructive')}
            role="status" aria-label={LINK_TEXT[link]} />
        </Tooltip>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12.5px] font-medium" title={meta?.workspace}>{meta ? baseName(meta.workspace) : '…'}</div>
          <div className="truncate text-[11px] text-subtle">{link === 'live' ? (meta ? `v${meta.version}` : '') : LINK_TEXT[link]}</div>
        </div>
        <Tooltip label="设置" side="top">
          <Button variant="ghost" size="icon-sm" aria-label="设置" onClick={onSettings}><Settings /></Button>
        </Tooltip>
      </div>
    </aside>
  );
}
