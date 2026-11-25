import { memo, useEffect, useRef, useState } from 'react';
import { Bot, Brain, Check, ChevronRight, FilePenLine, FileText, Globe, ListTodo, LoaderCircle, Search, Terminal, Workflow, Wrench, X } from 'lucide-react';
import { cn } from '@shared/cn';
import { useSettings } from '@/lib/settings';
import { inputText, summarize, type ToolFamily } from '@/lib/tools';
import type { ToolEntry } from '@/lib/types';
import { CopyButton } from './Markdown';

/** One thing the agent did on the way to its answer: a stretch of reasoning, or a tool call. */
export type Step =
  | { kind: 'reasoning'; key: string; content: string; active: boolean }
  | { kind: 'tool'; key: string; tool: ToolEntry };

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

const ROW = 'group/step flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] hover:bg-hover';
const CHEVRON = 'size-3.5 shrink-0 text-subtle opacity-0 transition-[transform,opacity] group-hover/step:opacity-100';

const ToolRow = memo(function ToolRow({ tool }: { tool: ToolEntry }) {
  const settings = useSettings();
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const shown = open ?? settings.expandTools;
  const summary = summarize(tool);
  const Icon = ICONS[summary.family];
  const input = inputText(tool);
  return (
    <div>
      <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)} className={ROW}>
        <Icon className={cn('size-3.5 shrink-0 text-muted-foreground', tool.status === 'error' && 'text-destructive')} />
        <span className="shrink-0 font-medium text-foreground/85">{summary.verb}</span>
        {summary.target && (
          <span className={cn('min-w-0 flex-1 truncate text-muted-foreground', summary.code || summary.family === 'read' || summary.family === 'write' || summary.family === 'search' ? 'mono text-[12px]' : '')}>
            {summary.target.replace(/\s+/g, ' ')}
          </span>
        )}
        {!summary.target && <span className="flex-1" />}
        <Status status={tool.status} />
        <ChevronRight className={cn(CHEVRON, shown && 'rotate-90 opacity-100')} />
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

/** What the model thought at this point. Closed, it says how the thought begins; while it is being thought, how it goes on. */
const ThoughtRow = memo(function ThoughtRow({ content, active }: { content: string; active: boolean }) {
  const settings = useSettings();
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const shown = open ?? settings.expandTools;
  const text = content.trim();
  const body = useRef<HTMLDivElement>(null);
  // A thought followed while it is written stays at its end.
  useEffect(() => { if (active && body.current) body.current.scrollTop = body.current.scrollHeight; }, [text, active, shown]);
  return (
    <div>
      <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)} className={ROW}>
        <Brain className={cn('size-3.5 shrink-0 text-muted-foreground', active && 'text-primary')} />
        <span className={cn('shrink-0 font-medium text-foreground/85', active && 'text-shimmer')}>{active ? '正在思考' : '思考'}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{!shown && !active && text.slice(0, 200).replace(/\s+/g, ' ')}</span>
        {active && <LoaderCircle className="size-3.5 animate-spin text-primary" aria-label="进行中" />}
        <ChevronRight className={cn(CHEVRON, shown && 'rotate-90 opacity-100')} />
      </button>
      {!shown && active && text && (
        // Closed while it is being thought, it shows its last lines: what is new is at the end.
        <div ref={body} aria-hidden className="mb-1 ml-[26px] mr-1 max-h-[3.4em] overflow-hidden whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-subtle [mask-image:linear-gradient(to_bottom,transparent,black_75%)]">
          {text.slice(-600)}
        </div>
      )}
      {shown && (
        <div ref={body} className="group/thought relative mb-1.5 ml-[26px] mr-1 mt-1 max-h-[26rem] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 text-[13px] leading-[1.7] text-muted-foreground animate-fade-in">
          {text}
          <CopyButton text={text} className="absolute right-1 top-1 bg-popover opacity-0 shadow-soft focus:opacity-100 group-hover/thought:opacity-100" />
        </div>
      )}
    </div>
  );
});

/** How many steps a finished stretch shows before it folds into one line. */
const FOLD_OVER = 4;

function tally(steps: Step[]): string {
  const thoughts = steps.filter(step => step.kind === 'reasoning').length;
  const calls = steps.length - thoughts;
  return [thoughts > 0 && `思考 ${thoughts} 次`, calls > 0 && `执行 ${calls} 步`].filter(Boolean).join(' · ');
}

/**
 * What the agent thought and did between two things it said, in the order it happened. While the run is going it
 * is all there to follow; once it is over a long stretch folds into one line, so the conversation reads as what
 * was said, with the work a click away.
 */
export const Steps = memo(function Steps({ steps, live }: { steps: Step[]; live: boolean }) {
  const settings = useSettings();
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const folds = steps.length > FOLD_OVER;
  const shown = open ?? (!folds || live || !settings.foldSteps);
  const failed = steps.filter(step => step.kind === 'tool' && step.tool.status === 'error').length;
  // Folded while it is going, a stretch still shows what is being done right now.
  const visible = shown ? steps : live ? steps.slice(-1) : [];
  return (
    <div className="my-2">
      {folds && (
        <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground">
          <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', shown && 'rotate-90')} />
          <span className={cn('font-medium', live && 'text-shimmer')}>{tally(steps)}{live && '，进行中'}</span>
          {failed > 0 && <span className="text-destructive">{failed} 步失败</span>}
        </button>
      )}
      {visible.length > 0 && (
        <div className={cn('border-l border-border-strong/70 pl-1', folds ? 'ml-[14px] mt-0.5' : 'ml-[7px]')}>
          {visible.map(step => step.kind === 'tool'
            ? <ToolRow key={step.key} tool={step.tool} />
            : <ThoughtRow key={step.key} content={step.content} active={step.active && live} />)}
        </div>
      )}
    </div>
  );
});
