import { memo, useMemo } from 'react';
import { ArrowRightLeft, Ban, CircleAlert, Clock, Hourglass, RefreshCw } from 'lucide-react';
import { clock, duration } from '@/lib/format';
import type { RunItem, RunSettings, RunState } from '@/lib/types';
import { useSession } from '@/lib/use-session';
import { CopyButton, Markdown } from './Markdown';
import { Steps, type Step } from './Steps';

type Segment = { kind: 'text'; key: string; content: string; streaming: boolean } | { kind: 'steps'; key: string; steps: Step[] };

/** Text as it was written, with what the agent thought and did between two texts taken together. */
function segments(state: RunState): Segment[] {
  const out: Segment[] = [];
  const step = (made: Step) => {
    const last = out.at(-1);
    if (last?.kind === 'steps') last.steps.push(made);
    else out.push({ kind: 'steps', key: `s${made.key}`, steps: [made] });
  };
  // A run recorded before reasoning was kept where it came has all of it in one piece, shown first.
  if (state.reasoning.content.trim()) step({ kind: 'reasoning', key: 'r', content: state.reasoning.content, active: state.reasoning.active });
  state.blocks.forEach((block, index) => {
    if (block.kind === 'text') {
      if (block.content.trim() || block.streaming) out.push({ kind: 'text', key: `t${index}`, content: block.content, streaming: block.streaming });
    } else if (block.kind === 'tool') step({ kind: 'tool', key: block.tool.id, tool: block.tool });
    else if (block.content.trim()) step({ kind: 'reasoning', key: `r${index}`, content: block.content, active: Boolean(block.active) });
  });
  return out;
}

/** The engine, model and effort a run used, as a person would say it. */
function settingsLabel(settings: RunSettings, agents: Array<{ value: string; label: string }> = []): string {
  return [agents.find(agent => agent.value === settings.agent)?.label ?? settings.agent, settings.model, settings.effort].filter(Boolean).join(' · ');
}

/** Everything the run said, for copying. */
function answerOf(state: RunState): string {
  const parts = state.blocks.flatMap(block => block.kind === 'text' && block.content.trim() ? [block.content.trim()] : []);
  if (state.finalText?.trim() && !parts.includes(state.finalText.trim())) parts.push(state.finalText.trim());
  return parts.join('\n\n');
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

/**
 * One run of the agent: what it thought, did and said, as far as it has got. `switched` marks a run that used
 * another engine, model or effort than the one before it.
 */
export const RunMessage = memo(function RunMessage({ item, switched }: { item: RunItem; switched?: boolean }) {
  const { state } = item;
  const agents = useSession(session => session.meta?.agents);
  const live = item.finishedAt === undefined && state.terminal === 'running';
  const parts = useMemo(() => segments(state), [state]);
  const texts = state.blocks.flatMap(block => block.kind === 'text' ? [block.content.trim()] : []);
  const closing = state.finalText?.trim() && !texts.includes(state.finalText.trim()) ? state.finalText : undefined;
  const last = parts.at(-1);
  const writing = last?.kind === 'text' && last.streaming;
  // A step that is still going says so on its own line.
  const stepGoing = last?.kind === 'steps' && last.steps.some(step => step.kind === 'tool' ? step.tool.status === 'running' : step.active);
  const empty = parts.length === 0 && !closing;
  const used = item.settings && settingsLabel(item.settings, agents);
  return (
    <article className="group/run pb-2 pt-1 animate-rise" aria-busy={live}>
      {switched && used && (
        <div className="my-1 flex items-center gap-2 text-[12px] text-subtle" role="note">
          <span className="h-px flex-1 bg-border" />
          <ArrowRightLeft className="size-3" />
          <span>改用 {used}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      {parts.map((part, index) => part.kind === 'text'
        ? <Markdown key={part.key} text={part.content} streaming={part.streaming && live} className="my-2" />
        : <Steps key={part.key} steps={part.steps} live={live && index === parts.length - 1} />)}
      {closing && <Markdown text={closing} className="my-2" />}
      {state.retry && live && <Retry retry={state.retry} />}
      {live && !writing && !stepGoing && !state.retry && <Working state={state} />}
      {!live && <Ending item={item} />}
      {!live && empty && state.terminal === 'done' && <p className="py-1 text-[13px] text-subtle">这次运行没有输出内容。</p>}
      {!live && !empty && (
        <div className="flex h-6 items-center gap-1 text-[12px] text-subtle opacity-0 transition-opacity focus-within:opacity-100 group-hover/run:opacity-100">
          {answerOf(state) && <CopyButton text={() => answerOf(state)} className="-ml-1.5" />}
          <span className="ml-1 inline-flex items-center gap-1" title={new Date(item.at).toLocaleString('zh-CN')}>
            <Clock className="size-3" />
            {clock(item.at)}
            {item.finishedAt !== undefined && item.finishedAt - item.at >= 1000 && <> · 用时 {duration(item.finishedAt - item.at)}</>}
            {used && <> · {used}</>}
          </span>
        </div>
      )}
    </article>
  );
});
