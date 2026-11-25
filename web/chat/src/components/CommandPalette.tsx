import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MessageSquare, Moon, PanelLeft, Settings, SquarePen, Sun, Workflow } from 'lucide-react';
import { cn } from '@shared/cn';
import { Dialog } from '@shared/ui/dialog';
import { ago } from '@/lib/format';
import { setSettings, setSidebar, useSidebar } from '@/lib/settings';
import { useSession, useSessionApi } from '@/lib/use-session';

interface Entry {
  key: string;
  icon: ReactNode;
  label: string;
  detail?: string;
  run(): void;
}

/** Everything reachable from the keyboard: the page's actions and every conversation, by typing a few letters. */
export function CommandPalette({ open, onOpenChange, onSettings, onPanel }: {
  open: boolean; onOpenChange(open: boolean): void; onSettings(): void; onPanel(): void;
}) {
  const session = useSessionApi();
  const sidebar = useSidebar();
  const conversations = useSession(state => state.conversations);
  const workflows = useSession(state => Boolean(state.meta?.workflows));
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  useEffect(() => { if (open) { setQuery(''); setAt(0); } }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const dark = document.documentElement.classList.contains('dark');
    const actions: Entry[] = [
      { key: 'new', icon: <SquarePen />, label: '新对话', run: () => session.open(undefined) },
      ...(workflows ? [{ key: 'panel', icon: <Workflow />, label: '显示或收起工作流面板', run: onPanel }] : []),
      { key: 'sidebar', icon: <PanelLeft />, label: sidebar ? '收起侧栏' : '展开侧栏', run: () => setSidebar(!sidebar) },
      { key: 'theme', icon: dark ? <Sun /> : <Moon />, label: dark ? '切换到浅色' : '切换到深色', run: () => setSettings({ theme: dark ? 'light' : 'dark' }) },
      { key: 'settings', icon: <Settings />, label: '设置', run: onSettings },
    ];
    const needle = query.trim().toLowerCase();
    const found = conversations
      .filter(conversation => !needle || `${conversation.title}\n${conversation.preview}`.toLowerCase().includes(needle))
      .slice(0, 30)
      .map<Entry>(conversation => ({
        key: `c:${conversation.id}`, icon: <MessageSquare />, label: conversation.title,
        detail: conversation.activeRunId ? '运行中' : ago(conversation.updatedAt), run: () => session.open(conversation.id),
      }));
    return [...actions.filter(action => !needle || action.label.toLowerCase().includes(needle)), ...found];
  }, [query, conversations, sidebar, workflows, open, session, onPanel, onSettings]);

  const current = Math.min(at, Math.max(0, entries.length - 1));
  const choose = (entry: Entry | undefined) => { if (!entry) return; onOpenChange(false); entry.run(); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="命令面板" hideClose className="top-[14vh] w-[min(92vw,580px)] overflow-hidden p-0">
      <input autoFocus value={query} onChange={event => { setQuery(event.target.value); setAt(0); }} placeholder="搜索对话，或输入要做的事…" aria-label="搜索"
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown') { event.preventDefault(); setAt((current + 1) % Math.max(1, entries.length)); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setAt((current - 1 + entries.length) % Math.max(1, entries.length)); }
          if (event.key === 'Enter') { event.preventDefault(); choose(entries[current]); }
        }}
        className="h-12 w-full border-b bg-transparent px-4 text-[15px] outline-none placeholder:text-subtle" />
      <div role="listbox" className="max-h-[46vh] overflow-y-auto p-1.5">
        {entries.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-subtle">没有找到匹配的内容</p>}
        {entries.map((entry, index) => (
          <button key={entry.key} type="button" role="option" aria-selected={index === current} onMouseMove={() => setAt(index)} onClick={() => choose(entry)}
            ref={node => { if (node && index === current) node.scrollIntoView({ block: 'nearest' }); }}
            className={cn('flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-[13.5px] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground', index === current && 'bg-hover')}>
            {entry.icon}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.detail && <span className="shrink-0 text-[12px] text-subtle">{entry.detail}</span>}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
