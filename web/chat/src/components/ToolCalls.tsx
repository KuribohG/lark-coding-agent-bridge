import { memo, useState } from 'react';
import { Bot, Check, ChevronRight, FilePenLine, FileText, Globe, ListTodo, LoaderCircle, Search, Terminal, Workflow, Wrench, X } from 'lucide-react';
import { cn } from '@shared/cn';
import { useSettings } from '@/lib/settings';
import { inputText, summarize, type ToolFamily } from '@/lib/tools';
import type { ToolEntry } from '@/lib/types';
import { CopyButton } from './Markdown';

const ICONS: Record<ToolFamily, typeof Terminal> = {
  shell: Terminal, read: FileText, write: FilePenLine, search: Search, web: Globe, agent: Bot, plan: ListTodo, workflow: Workflow, other: Wrench,
};

function Status({ status }: { status: ToolEntry['status'] }) {
  if (status === 'running') return <LoaderCircle className="size-3.5 animate-spin text-primary" aria-label="进行中" />;
  if (status === 'error') return <X className="size-3.5 text-destructive" aria-label="失败" />;
  return <Check className="size-3.5 text-subtle" aria-label="完成" />;
}

function Pane({ label, text, tone }: { label: string; text: string; tone?: 'error' }) {
  return (
    <div className="overflow-hidden rounded-md border border-code-border bg-code">
      <div className="flex h-7 items-center justify-between border-b border-code-border pl-2.5 pr-1">
        <span className="text-[11px] font-medium tracking-wide text-subtle">{label}</span>
        <CopyButton text={text} className="py-0.5" />
      </div>
      <pre className={cn('mono max-h-72 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 text-[12px] leading-[1.55] text-code-foreground',
        tone === 'error' && 'text-destructive')}>{text}</pre>
    </div>
  );
}

const ToolRow = memo(function ToolRow({ tool }: { tool: ToolEntry }) {
  const settings = useSettings();
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const shown = open ?? settings.expandTools;
  const summary = summarize(tool);
  const Icon = ICONS[summary.family];
  const input = inputText(tool);
  return (
    <div>
      <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)}
        className="group/tool flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] hover:bg-hover">
        <Icon className={cn('size-3.5 shrink-0 text-muted-foreground', tool.status === 'error' && 'text-destructive')} />
        <span className="shrink-0 font-medium text-foreground/85">{summary.verb}</span>
        {summary.target && (
          <span className={cn('min-w-0 flex-1 truncate text-muted-foreground', summary.code || summary.family === 'read' || summary.family === 'write' || summary.family === 'search' ? 'mono text-[12px]' : '')}>
            {summary.target.replace(/\s+/g, ' ')}
          </span>
        )}
        {!summary.target && <span className="flex-1" />}
        <Status status={tool.status} />
        <ChevronRight className={cn('size-3.5 shrink-0 text-subtle opacity-0 transition-[transform,opacity] group-hover/tool:opacity-100', shown && 'rotate-90 opacity-100')} />
      </button>
      {shown && (
        <div className="mb-1.5 ml-[26px] mr-1 mt-1 space-y-1.5 animate-fade-in">
          {input && <Pane label={summary.family === 'shell' ? '命令' : '输入'} text={input} />}
          {tool.output !== undefined && tool.output !== ''
            ? <Pane label={tool.status === 'error' ? '错误' : '输出'} text={tool.output} tone={tool.status === 'error' ? 'error' : undefined} />
            : tool.status !== 'running' && <p className="px-0.5 text-[12px] text-subtle">没有输出</p>}
        </div>
      )}
    </div>
  );
});

/** How many calls a finished stretch shows before it folds into one line. */
const FOLD_OVER = 4;

/**
 * A stretch of consecutive tool calls. A long one folds into a single line once it is over, so the conversation
 * reads as what was said, with the work a click away.
 */
export const ToolCalls = memo(function ToolCalls({ tools, live }: { tools: ToolEntry[]; live: boolean }) {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const folds = tools.length > FOLD_OVER;
  const shown = open ?? !folds;
  const failed = tools.filter(tool => tool.status === 'error').length;
  const running = tools.filter(tool => tool.status === 'running').length;
  // While it is going, a folded stretch still shows what is being done right now.
  const visible = shown ? tools : live ? tools.slice(-1) : [];
  return (
    <div className="my-2 rounded-lg border bg-card/60 p-1">
      {folds && (
        <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] text-muted-foreground hover:bg-hover">
          <ChevronRight className={cn('size-3.5 transition-transform', shown && 'rotate-90')} />
          <span className="font-medium text-foreground/85">{live && running ? `已执行 ${tools.length - running} 步，进行中` : `执行了 ${tools.length} 步`}</span>
          {failed > 0 && <span className="text-destructive">{failed} 步失败</span>}
        </button>
      )}
      {visible.map(tool => <ToolRow key={tool.id} tool={tool} />)}
    </div>
  );
});
