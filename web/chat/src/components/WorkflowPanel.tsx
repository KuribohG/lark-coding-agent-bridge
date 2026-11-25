import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, CircleAlert, MessagesSquare, Users, Workflow, X } from 'lucide-react';
import { cn } from '@shared/cn';
import { Button } from '@shared/ui/button';
import { ago, clock } from '@/lib/format';
import { useSession, useSessionApi } from '@/lib/use-session';
import type { BoardView, MemberView, OverviewView, QueueView, Tone, WorkflowSummary, WorkItemView, WorkStatus, WorkView } from '@/lib/workflow-types';
import { Markdown } from './Markdown';

const STAGES: Record<WorkflowSummary['stage'], string> = {
  done: '已完成', cancelled: '已取消', binding: '等待确认', paused: '已暂停', interrupted: '已中断', script_failed: '脚本出错',
  summarizing: '正在汇总', queued: '排队中', running: '运行中',
};
const TONES: Record<Tone, string> = {
  running: 'bg-accent text-accent-foreground', attention: 'bg-warning-soft text-warning', failed: 'bg-destructive-soft text-destructive',
  done: 'bg-success-soft text-success', cancelled: 'bg-muted text-muted-foreground',
};
const PHASES: Record<string, [string, Tone]> = {
  running: ['运行中', 'running'], starting: ['启动中', 'running'], slot: ['等待名额', 'attention'], queued: ['排队中', 'cancelled'],
  input: ['等待输入', 'attention'], child: ['等待子工作流', 'running'], cancelling: ['正在取消', 'cancelled'], idle: ['空闲', 'cancelled'],
  waiting: ['等待中', 'cancelled'], ready: ['就绪', 'running'], failed: ['失败', 'failed'], retired: ['已退出', 'cancelled'], done: ['已完成', 'done'],
  cancelled: ['已取消', 'cancelled'], interrupted: ['已中断', 'attention'], unknown: ['未知', 'cancelled'], unstarted: ['未开始', 'cancelled'],
};
const ROLES: Record<MemberView['role'], string> = { lead: '负责人', 'queue-lead': '队列负责人', worker: '成员', member: '成员', agent: 'agent' };
const WORK: Record<WorkStatus, [string, Tone]> = {
  pending: ['待处理', 'cancelled'], claimed: ['进行中', 'running'], completed: ['已完成', 'done'], failed: ['失败', 'failed'], cancelled: ['已取消', 'cancelled'],
};

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium', TONES[tone])}>
    {tone === 'running' && <span className="size-1.5 rounded-full bg-primary animate-pulse-dot" />}{children}</span>;
}

/** Done, going and waiting as one bar, so a long queue reads at a glance. */
function Progress({ counts }: { counts: Record<WorkStatus, number> }) {
  const total = counts.pending + counts.claimed + counts.completed + counts.failed + counts.cancelled;
  if (total === 0) return null;
  const part = (count: number) => `${(count / total) * 100}%`;
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${counts.completed} / ${total} 已完成`}>
      <div className="bg-success" style={{ width: part(counts.completed) }} />
      <div className="bg-primary" style={{ width: part(counts.claimed) }} />
      <div className="bg-destructive" style={{ width: part(counts.failed) }} />
    </div>
  );
}

/** Reads one of the workflow views again every few seconds while shown; an unchanged answer costs a 304. */
function useView<T>(path: string | null, everyMs = 3000): { data?: T; error?: string } {
  const session = useSessionApi();
  const [result, setResult] = useState<{ path: string; data?: T; error?: string }>({ path: '' });
  const etag = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!path) return;
    etag.current = undefined;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const answer = await session.api.workflows<T & { error?: string }>(path, etag.current, abort.signal);
        if (abort.signal.aborted) return;
        if (answer.status === 200) { etag.current = answer.etag; setResult({ path, data: answer.body }); }
        else if (answer.status !== 304) setResult(known => ({ path, data: known.path === path ? known.data : undefined, error: answer.body?.error ?? `读取失败（${answer.status}）` }));
      } catch { /* the next round tries again */ }
      if (!abort.signal.aborted) timer = setTimeout(load, document.hidden ? everyMs * 4 : everyMs);
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [path, everyMs, session]);
  return result.path === path ? result : {};
}

function Card({ workflow, onOpen }: { workflow: WorkflowSummary; onOpen(): void }) {
  if (workflow.unreadable) {
    return (
      <div className="rounded-xl border bg-card px-3.5 py-3 text-[12.5px] text-muted-foreground">
        <div className="mono text-[11.5px]">{workflow.id.slice(0, 8)}</div>
        <div className="mt-1">这个版本读不了这个工作流：{workflow.unreadable}</div>
      </div>
    );
  }
  return (
    <button type="button" onClick={onOpen}
      className="block w-full rounded-xl border bg-card px-3.5 py-3 text-left transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-soft">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{workflow.name || '工作流'}</span>
        <Badge tone={workflow.tone}>{STAGES[workflow.stage]}</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">{workflow.goal}</p>
      {workflow.work && workflow.work.total > 0 && <div className="mt-2.5"><Progress counts={workflow.work} /></div>}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-subtle">
        {workflow.work && workflow.work.total > 0 && <span>任务 {workflow.work.completed}/{workflow.work.total}</span>}
        <span>成员 {workflow.members.running}/{workflow.members.total} 在跑</span>
        {workflow.turns.failed > 0 && <span className="text-destructive">{workflow.turns.failed} 轮失败</span>}
        {workflow.asks > 0 && <span className="text-warning">{workflow.asks} 个待答</span>}
        <span className="ml-auto">{ago(workflow.updatedAt ?? workflow.createdAt)}</span>
      </div>
    </button>
  );
}

/** A long text shows its beginning; the rest is a click away. */
function Folded({ text }: { text: string }) {
  const long = text.length > 420;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={cn('relative', long && !open && 'max-h-40 overflow-hidden')}>
        <Markdown text={text} compact breaks />
        {long && !open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-sidebar to-transparent" />}
      </div>
      {long && <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-[12px] text-primary hover:underline">{open ? '收起' : '展开全部'}</button>}
    </>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-t px-4 py-3.5 first:border-t-0">
      <h4 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium text-subtle">{title}{count !== undefined && <span>· {count}</span>}</h4>
      {children}
    </section>
  );
}

function Queue({ queue }: { queue: QueueView }) {
  const total = Object.values(queue.counts).reduce((sum, count) => sum + count, 0);
  return (
    <div className="py-1.5">
      <div className="mb-1 flex items-baseline gap-2 text-[12.5px]">
        <span className="mono min-w-0 truncate font-medium">{queue.name}</span>
        {!queue.open && <span className="text-[11px] text-subtle">已关闭</span>}
        <span className="ml-auto shrink-0 text-subtle">{queue.counts.completed}/{total}{queue.counts.failed > 0 && <span className="text-destructive"> · {queue.counts.failed} 失败</span>}</span>
      </div>
      <Progress counts={queue.counts} />
    </div>
  );
}

function Members({ base }: { base: string }) {
  const { data } = useView<{ members: MemberView[] }>(`${base}/members`);
  if (!data) return <Loading />;
  if (data.members.length === 0) return <Empty>还没有成员</Empty>;
  return (
    <ul className="divide-y">
      {data.members.map(member => {
        const [label, tone] = PHASES[member.phase] ?? [member.phase, 'cancelled' as Tone];
        return (
          <li key={member.name} className="px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="mono min-w-0 truncate text-[12.5px] font-medium">{member.name}</span>
              <span className="shrink-0 text-[11px] text-subtle">{ROLES[member.role]}</span>
              <span className="flex-1" />
              <Badge tone={tone}>{label}</Badge>
            </div>
            {member.item && <div className="mt-1 truncate text-[12px] text-muted-foreground" title={member.item.title}>正在处理：{member.item.title}</div>}
            {member.task?.error && <div className="mt-1 line-clamp-2 text-[12px] text-destructive">{member.task.error}</div>}
            <div className="mt-1 flex gap-3 text-[11.5px] text-subtle">
              <span>{member.agent}{member.model ? ` · ${member.model}` : ''}</span>
              <span>{member.turns} 轮</span>
              {member.itemsDone + member.itemsFailed > 0 && <span>完成 {member.itemsDone}{member.itemsFailed > 0 && `，失败 ${member.itemsFailed}`}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Work({ base }: { base: string }) {
  const { data } = useView<WorkView>(`${base}/work?limit=100`);
  if (!data) return <Loading />;
  if (data.items.length === 0) return <Empty>这个工作流没有任务队列</Empty>;
  return (
    <>
      <ul className="divide-y">
        {data.items.map((item: WorkItemView) => {
          const [label, tone] = WORK[item.status];
          return (
            <li key={item.id} className="px-4 py-2.5">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[12.5px] leading-snug">{item.title || item.key}</span>
                <Badge tone={item.hold ? 'attention' : tone}>{item.hold ? '搁置' : label}</Badge>
              </div>
              <div className="mt-1 flex gap-3 text-[11.5px] text-subtle">
                <span className="mono">{item.queue}</span>
                {(item.assignee ?? item.doneBy) && <span>{item.assignee ?? item.doneBy}</span>}
                <span className="ml-auto">{ago(item.updatedAt)}</span>
              </div>
              {item.error && <div className="mt-1 line-clamp-2 text-[12px] text-destructive">{item.error}</div>}
            </li>
          );
        })}
      </ul>
      {data.total > data.items.length && <p className="border-t px-4 py-3 text-center text-[12px] text-subtle">共 {data.total} 项，这里显示前 {data.items.length} 项</p>}
    </>
  );
}

function Board({ base }: { base: string }) {
  const { data } = useView<BoardView>(`${base}/board?limit=40`);
  if (!data) return <Loading />;
  if (data.posts.length === 0) return <Empty>成员之间还没有留言</Empty>;
  return (
    <ul className="divide-y">
      {data.posts.map(post => (
        <li key={post.seq} className="px-4 py-3">
          <div className="mb-1 flex items-baseline gap-1.5 text-[12px]">
            <span className="mono font-medium">{post.from}</span>
            <span className="min-w-0 truncate text-subtle">→ {post.all ? '所有人' : post.to.join('、') || '留言板'}</span>
            {post.ask?.open && <Badge tone="attention">待回答</Badge>}
            <span className="ml-auto shrink-0 text-subtle">{clock(post.createdAt)}</span>
          </div>
          <Markdown text={post.text + (post.truncated ? ' …' : '')} compact breaks />
        </li>
      ))}
    </ul>
  );
}

const Loading = () => <div className="space-y-2.5 px-4 py-4" aria-hidden>{[80, 60, 72].map(width => <div key={width} className="h-3 rounded-full bg-muted animate-pulse" style={{ width: `${width}%` }} />)}</div>;
const Empty = ({ children }: { children: ReactNode }) => <p className="px-4 py-10 text-center text-[12.5px] text-subtle">{children}</p>;

type Tab = 'overview' | 'members' | 'work' | 'board';

function Detail({ source, id, onBack }: { source: string; id: string; onBack(): void }) {
  const base = `/s/${encodeURIComponent(source)}/w/${encodeURIComponent(id)}`;
  const { data, error } = useView<OverviewView>(`${base}/overview`);
  const [tab, setTab] = useState<Tab>('overview');
  const summary = data?.summary;
  const tabs: Array<[Tab, string, number | undefined]> = [
    ['overview', '概览', undefined], ['members', '成员', summary?.members.total], ['work', '任务', summary?.work?.total], ['board', '留言', undefined],
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
        <Button variant="ghost" size="icon-sm" aria-label="返回列表" onClick={onBack}><ArrowLeft /></Button>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{summary?.name || '工作流'}</span>
        {summary && <Badge tone={summary.tone}>{STAGES[summary.stage]}</Badge>}
      </div>
      <div role="tablist" className="flex gap-0.5 border-b px-2.5">
        {tabs.map(([key, label, count]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={cn('-mb-px border-b-2 px-2.5 pb-2 pt-1 text-[12.5px] transition-colors',
              tab === key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}{count ? <span className="ml-1 text-subtle">{count}</span> : null}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="m-4 flex gap-2 rounded-lg bg-destructive-soft px-3 py-2 text-[12.5px] text-destructive"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{error}</p>}
        {tab === 'overview' && (data ? (
          <>
            <Section title="目标"><Folded text={data.goal} /></Section>
            {data.script?.error && <Section title="脚本出错"><p className="whitespace-pre-wrap break-words text-[12.5px] text-destructive">{data.script.error}</p></Section>}
            {data.statuses.length > 0 && (
              <Section title="最新进展">
                {data.statuses.map(status => (
                  <div key={status.lead} className="mb-3 last:mb-0">
                    <div className="mb-1 flex gap-2 text-[11.5px] text-subtle"><span className="mono">{status.lead}</span><span>{ago(status.at)}</span></div>
                    <Folded text={status.text} />
                  </div>
                ))}
              </Section>
            )}
            {data.queues.length > 0 && <Section title="任务队列" count={data.queues.length}>{data.queues.map(queue => <Queue key={queue.name} queue={queue} />)}</Section>}
            {data.asks.length > 0 && (
              <Section title="等待回答" count={data.asks.length}>
                {data.asks.map(ask => (
                  <div key={ask.seq} className="mb-2 rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] last:mb-0">
                    <div className="mb-0.5 text-[11.5px] text-muted-foreground"><span className="mono">{ask.from}</span> 问 <span className="mono">{ask.to}</span> · {ago(ask.at)}</div>
                    {ask.excerpt}
                  </div>
                ))}
              </Section>
            )}
            {data.todos.length > 0 && (
              <Section title="需要处理" count={data.todos.length}>
                <ul className="space-y-1.5 text-[12.5px]">{data.todos.map(todo => <li key={todo.id}>{todo.subject}{todo.holder && <span className="text-subtle">（{todo.holder}）</span>}</li>)}</ul>
              </Section>
            )}
            <Section title="信息">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
                <dt className="text-muted-foreground">引擎</dt><dd>{data.summary.agent}{data.summary.model ? ` · ${data.summary.model}` : ''}</dd>
                <dt className="text-muted-foreground">开始于</dt><dd>{clock(data.summary.createdAt)}</dd>
                <dt className="text-muted-foreground">轮次</dt><dd>{data.summary.turns.done} 完成 · {data.summary.turns.running} 进行中{data.summary.turns.failed > 0 && ` · ${data.summary.turns.failed} 失败`}</dd>
                <dt className="text-muted-foreground">编号</dt><dd className="mono text-[12px]">{data.summary.id.slice(0, 8)}</dd>
              </dl>
            </Section>
          </>
        ) : !error && <Loading />)}
        {tab === 'members' && <Members base={base} />}
        {tab === 'work' && <Work base={base} />}
        {tab === 'board' && <Board base={base} />}
      </div>
    </div>
  );
}

/** The workflows of the open conversation, beside it: what each is doing, who is on it, and what they told each other. */
export function WorkflowPanel({ onClose, onStart }: { onClose(): void; onStart(): void }) {
  const conversationId = useSession(state => state.conversationId);
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => setOpened(null), [conversationId]);
  const { data } = useView<{ source: string; workflows: WorkflowSummary[] }>(conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : null, 4000);
  const workflows = data?.workflows ?? [];
  return (
    <aside className="flex h-full w-[400px] shrink-0 flex-col border-l bg-sidebar" aria-label="工作流">
      <div className="flex h-13 shrink-0 items-center gap-2 px-4">
        <Workflow className="size-4 text-primary" />
        <h2 className="flex-1 text-[14px] font-semibold">工作流</h2>
        <Button variant="ghost" size="icon-sm" aria-label="收起工作流" onClick={onClose}><X /></Button>
      </div>
      {opened && data ? <Detail source={data.source} id={opened} onBack={() => setOpened(null)} /> : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
          {conversationId && !data && <Loading />}
          {workflows.map(workflow => <Card key={workflow.id} workflow={workflow} onOpen={() => setOpened(workflow.id)} />)}
          {(!conversationId || (data && workflows.length === 0)) && (
            <div className="px-3 pt-12 text-center">
              <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground"><Users className="size-5" /></div>
              <h3 className="mt-4 text-[14px] font-medium">让多个 agent 一起做</h3>
              <p className="mx-auto mt-1.5 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">
                一个任务太大时，工作流会把它拆开，交给多个 agent 并行完成，再把结果汇总回这个对话。
              </p>
              <Button variant="soft" className="mt-4" onClick={onStart}><MessagesSquare />开始一个工作流</Button>
              <p className="mt-3 text-[11.5px] text-subtle">或在消息框输入 <span className="mono">/workflow start 任务</span></p>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
