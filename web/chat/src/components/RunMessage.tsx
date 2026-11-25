import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Brain, ChevronRight, CircleAlert, Clock, Hourglass, RefreshCw } from 'lucide-react';
import { cn } from '@shared/cn';
import { clock, duration } from '@/lib/format';
import type { Block, RunItem, RunState, ToolEntry } from '@/lib/types';
import { CopyButton, Markdown } from './Markdown';
import { ToolCalls } from './ToolCalls';

type Segment = { kind: 'text'; key: string; content: string; streaming: boolean } | { kind: 'tools'; key: string; tools: ToolEntry[] };

/** Text as it was written, with each stretch of consecutive tool calls taken together. */
function segments(blocks: Block[]): Segment[] {
  const out: Segment[] = [];
  blocks.forEach((block, index) => {
    if (block.kind === 'text') {
      if (block.content.trim() || block.streaming) out.push({ kind: 'text', key: `t${index}`, content: block.content, streaming: block.streaming });
      return;
    }
    const last = out.at(-1);
    if (last?.kind === 'tools') last.tools.push(block.tool);
    else out.push({ kind: 'tools', key: `g${index}`, tools: [block.tool] });
  });
  return out;
}

/** Everything the run said, for copying. */
function answerOf(state: RunState): string {
  const parts = state.blocks.flatMap(block => block.kind === 'text' && block.content.trim() ? [block.content.trim()] : []);
  if (state.finalText?.trim() && !parts.includes(state.finalText.trim())) parts.push(state.finalText.trim());
  return parts.join('\n\n');
}

function Reasoning({ content, active }: { content: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active && !open && tail.current) tail.current.scrollTop = tail.current.scrollHeight; }, [content, active, open]);
  return (
    <div className="my-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="group/think -ml-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground">
        <Brain className="size-3.5" />
        <span className={cn(active && 'text-shimmer')}>{active ? '正在思考' : '思考过程'}</span>
        <ChevronRight className={cn('size-3.5 text-subtle transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-border-strong py-0.5 pl-3.5 text-[13.5px] leading-[1.7] text-muted-foreground animate-fade-in">
          {content}
        </div>
      ) : active && (
        <div ref={tail} className="mt-1 max-h-[3.4em] overflow-hidden whitespace-pre-wrap border-l-2 border-border py-0.5 pl-3.5 text-[13px] leading-[1.7] text-subtle [mask-image:linear-gradient(to_bottom,transparent,black_70%)]">
          {content.slice(-400)}
        </div>
      )}
    </div>
  );
}

function Working({ state }: { state: RunState }) {
  const label = state.footer === 'tool_running' ? '正在执行' : state.footer === 'streaming' ? '正在输出' : '思考中';
  return (
    <div className="flex items-center gap-2 py-1.5 text-[13px]" role="status">
      <span className="flex gap-1">
        {[0, 1, 2].map(dot => <span key={dot} className="size-1.5 rounded-full bg-primary animate-pulse-dot" style={{ animationDelay: `${dot * 0.18}s` }} />)}
      </span>
      <span className="text-shimmer">{label}</span>
    </div>
  );
}

function Retry({ retry }: { retry: NonNullable<RunState['retry']> }) {
  const reason = retry.failureKind === 'transient' ? '模型服务暂时不可用' : retry.failureKind === 'authentication' ? '模型服务鉴权失败' : '模型服务限流';
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[13px]" role="status">
      <RefreshCw className="size-3.5 animate-spin text-warning [animation-duration:2.4s]" />
      <span>{reason}，{retry.delayMs > 0 ? `${Math.ceil(retry.delayMs / 1000)} 秒后自动重试` : '正在自动重试'}</span>
      <span className="text-muted-foreground">第 {retry.attempt} / {retry.maxAttempts} 次</span>
    </div>
  );
}

function Ending({ item }: { item: RunItem }) {
  const { state } = item;
  if (state.terminal === 'error' || item.error || item.result === 'failed' || item.result === 'quota') {
    const message = state.errorMsg || (item.result === 'quota' ? '模型额度已用完。' : item.error === 'conversation failed' || !item.error ? '这次运行没有正常结束。' : item.error);
    return (
      <div className="my-2 flex gap-2.5 rounded-lg border border-destructive/25 bg-destructive-soft px-3.5 py-2.5 text-[13.5px]" role="alert">
        <CircleAlert className="mt-[3px] size-4 shrink-0 text-destructive" />
        <div className="min-w-0 whitespace-pre-wrap break-words">{message}</div>
      </div>
    );
  }
  if (state.terminal === 'idle_timeout') {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[13px]">
        <Hourglass className="size-3.5 text-warning" />
        {state.idleTimeoutMinutes ? `${state.idleTimeoutMinutes} 分钟没有任何进展，已停止等待。` : '长时间没有进展，已停止等待。'}
      </div>
    );
  }
  if (state.terminal === 'interrupted' || item.result === 'stopped' || item.result === 'expired') {
    return (
      <div className="my-1.5 inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[12.5px] text-muted-foreground">
        <Ban className="size-3.5" />
        {item.lost ? '服务重启，这次运行被中断' : item.result === 'expired' ? '已到时限，运行结束' : '已停止'}
      </div>
    );
  }
  return null;
}

/** One run of the agent: what it thought, did and said, as far as it has got. */
export const RunMessage = memo(function RunMessage({ item }: { item: RunItem }) {
  const { state } = item;
  const live = item.finishedAt === undefined && state.terminal === 'running';
  const parts = useMemo(() => segments(state.blocks), [state.blocks]);
  const texts = state.blocks.flatMap(block => block.kind === 'text' ? [block.content.trim()] : []);
  const closing = state.finalText?.trim() && !texts.includes(state.finalText.trim()) ? state.finalText : undefined;
  const last = parts.at(-1);
  const writing = last?.kind === 'text' && last.streaming;
  // A tool that is still going says so on its own line.
  const toolGoing = last?.kind === 'tools' && last.tools.some(tool => tool.status === 'running');
  const empty = parts.length === 0 && !closing && !state.reasoning.content;
  return (
    <article className="group/run pb-2 pt-1 animate-rise" aria-busy={live}>
      {state.reasoning.content && <Reasoning content={state.reasoning.content} active={state.reasoning.active && live} />}
      {parts.map((part, index) => part.kind === 'text'
        ? <Markdown key={part.key} text={part.content} streaming={part.streaming && live} className="my-2" />
        : <ToolCalls key={part.key} tools={part.tools} live={live && index === parts.length - 1} />)}
      {closing && <Markdown text={closing} className="my-2" />}
      {state.retry && live && <Retry retry={state.retry} />}
      {live && !writing && !toolGoing && !state.retry && !(state.reasoning.active && state.reasoning.content) && <Working state={state} />}
      {!live && <Ending item={item} />}
      {!live && empty && state.terminal === 'done' && <p className="py-1 text-[13px] text-subtle">这次运行没有输出内容。</p>}
      {!live && !empty && (
        <div className="flex h-6 items-center gap-1 text-[12px] text-subtle opacity-0 transition-opacity focus-within:opacity-100 group-hover/run:opacity-100">
          {answerOf(state) && <CopyButton text={() => answerOf(state)} className="-ml-1.5" />}
          <span className="ml-1 inline-flex items-center gap-1" title={new Date(item.at).toLocaleString('zh-CN')}>
            <Clock className="size-3" />
            {clock(item.at)}
            {item.finishedAt !== undefined && item.finishedAt - item.at >= 1000 && <> · 用时 {duration(item.finishedAt - item.at)}</>}
          </span>
        </div>
      )}
    </article>
  );
});
