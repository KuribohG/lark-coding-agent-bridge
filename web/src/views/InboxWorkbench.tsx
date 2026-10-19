import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { InboxConfig } from '../../../src/inbox/config';
import type { WorkItemConcurrency } from '../../../src/work-items/concurrency';
import type { guiContent, guiSummary } from '../../../src/inbox/presentation';

type Summary = ReturnType<typeof guiSummary>;
type Detail = Summary & ReturnType<typeof guiContent>;
export type WorkbenchView = { config: InboxConfig; configFile?: string; configRevision?: string; concurrency?: WorkItemConcurrency; concurrencyRevision?: string; running: boolean; connected: boolean; error?: string; sources?: { id: string; label: string; running: boolean; error?: string; health?: { checkedAt?: number; checks: { id: string; state: string; detail: string; lastSuccessAt?: number }[] } }[]; jobs: (Summary & { detail?: ReturnType<typeof guiContent> })[] };
type Command = (action: string, target: unknown) => Promise<unknown>;
const stateNames: Record<string, string> = { waiting: '待处理', notifying: '准备通知', queued: '等待分析', running: '分析中', ready: '待投递', done: '分析完成', ignored: '已忽略', claimed: '已处理', failed: '分析失败' };
const category = (job: Summary) => job.handlingState !== 'open' || job.attention?.state === 'quiet' ? 'history' : job.attention?.state === 'needed' || ['queued', 'running', 'ready', 'done', 'failed'].includes(job.state) ? 'pending' : 'screening';

export function InboxWorkbench({ view, command }: { view: WorkbenchView; command: Command }) {
  const [tab, setTab] = useState('pending');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [detail, setDetail] = useState<Detail>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [chats, setChats] = useState<{ id: string; name: string }[]>([]);
  const [chatType, setChatType] = useState<'p2p' | 'group'>('p2p');
  const [page, setPage] = useState('');
  const [manual, setManual] = useState('');
  const [notice, setNotice] = useState('');
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const show = async (job: WorkbenchView['jobs'][number]) => {
    const result = job.detail ? { ...job, ...job.detail } : await command('detail', job.id) as Detail;
    setDetail(result);
  };
  const browse = async (type: 'p2p' | 'group', next = '') => {
    const result = await command('browse', { type, page: next }) as { chats: typeof chats; next: string };
    setChats(next ? [...chats, ...result.chats] : result.chats); setPage(result.next); setChatType(type);
  };
  const inSource = (job: Summary) => source === 'all' || job.sourceKind === source;
  const list = view.jobs.filter(j => inSource(j) && category(j) === tab && (!query || `${j.name} ${j.preview} ${j.attention?.reason}`.toLowerCase().includes(query.toLowerCase())));
  return <section className="space-y-3">
    <div className="flex flex-wrap gap-2">{[['all', '全部来源'], ['conversation', '飞书会话'], ...(view.sources ?? []).map(s => [s.id, s.label])].map(([id, label]) => <Button key={id} variant={source === id ? 'secondary' : 'outline'} onClick={() => { setSource(id!); setSelection({}); }}>{label}</Button>)}</div>
    {(view.sources ?? []).map(s => <p key={s.id} className="text-xs text-muted-foreground">{s.label}：{s.running ? '已开启' : '已暂停'}{s.error ? ` · ${s.error}` : ''}</p>)}
    {(view.sources ?? []).filter(s => s.health).map(s => <details key={`${s.id}-health`} className="text-xs"><summary>{s.label} · 采集覆盖（{s.health!.checks.length}）</summary>
      <p>最近轮询：{s.health!.checkedAt ? new Date(s.health!.checkedAt).toLocaleString() : '尚未完成'}</p>
      {s.health!.checks.map(c => <p key={c.id}>{c.id} · {({ healthy: '正常', alert: '异常', unknown: '未知', idle: '无活动', pending: '待检查' } as Record<string, string>)[c.state] ?? c.state} · {c.detail}{c.lastSuccessAt ? ` · 上次成功 ${new Date(c.lastSuccessAt).toLocaleString()}` : ''}</p>)}
    </details>)}
    <div className="flex flex-wrap gap-2">{[['pending', '待处理'], ['screening', '筛选与待核对'], ['history', '历史']].map(([value, label]) => <Button key={value} variant={tab === value ? 'secondary' : 'outline'} onClick={() => { setTab(value); setSelection({}); }}>{label} ({view.jobs.filter(j => inSource(j) && category(j) === value).length})</Button>)}</div>
    <Input aria-label="搜索待办" placeholder="搜索会话、消息或筛选原因" value={query} onChange={e => setQuery(e.target.value)} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {Object.keys(selection).length > 0 && <div className="flex flex-wrap items-center gap-2 text-sm">已选 {Object.keys(selection).length} 项
      {(['handled', 'ignored'] as const).map(state => <Button key={state} variant="outline" disabled={busy || !view.connected} onClick={() => void perform(async () => {
        await command('batch', { handlingState: state, items: Object.entries(selection).map(([id, revision]) => ({ id, revision })) }); setSelection({});
      })}>{state === 'handled' ? '标记已处理' : '忽略所选'}</Button>)}
    </div>}
    <div className="max-h-[28rem] space-y-2 overflow-y-auto">
      {!list.length && <p className="py-6 text-center text-sm text-muted-foreground">{view.connected ? '当前没有事项' : '完成下方配置并启动执行 profile 后，在这里查看待办'}</p>}
      {list.map(job => <article key={job.id} className="flex items-start gap-3 rounded-lg border p-3">
        <input type="checkbox" aria-label={`选择 ${job.name}`} checked={job.id in selection} onChange={e => setSelection(old => { const next = { ...old }; if (e.target.checked) next[job.id] = job.revision; else delete next[job.id]; return next; })} />
        <button className="min-w-0 flex-1 space-y-1 text-left" onClick={() => void perform(() => show(job))} disabled={busy}>
          <div className="flex flex-wrap justify-between gap-2 text-sm"><strong>{job.name}</strong><span>{stateNames[job.state] || job.state}</span></div>
          <p className="line-clamp-2 text-sm">{job.attention?.reason || job.preview}</p>
          {job.attention?.progress && <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">筛选中：{job.attention.progress.text}</p>}
          <p className="text-xs text-muted-foreground">{new Date(job.updatedAt).toLocaleString()} · {job.sourceKind === 'conversation' ? `${job.messageCount} 条消息` : job.sourceKind} · {job.executorProfile}</p>
        </button>
      </article>)}
    </div>
    {detail && <JobDetail key={detail.id} detail={detail} latest={view.jobs.find(j => j.id === detail.id)} connected={view.connected} running={detail.sourceKind === 'conversation' ? view.running : Boolean(view.sources?.find(s => s.id === detail.sourceKind)?.running)} command={command} onClose={() => setDetail(undefined)} />}
    <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">主动选择会话分析</summary>
      <div className="mt-3 space-y-2">
        <div className="flex gap-2"><Button variant="outline" disabled={busy || !view.running} onClick={() => void perform(() => browse('p2p'))}>最近私聊</Button><Button variant="outline" disabled={busy || !view.running} onClick={() => void perform(() => browse('group'))}>最近群聊</Button></div>
        {chats.map(chat => <div key={chat.id} className="flex items-center justify-between gap-3 text-sm"><span>{chat.name}</span><Button variant="ghost" disabled={busy || !view.running} onClick={() => void perform(async () => { await command('manual', chat.id); setTab('pending'); setNotice('已提交分析，请在待处理中查看进度。'); })}>分析</Button></div>)}
        {page && <Button variant="ghost" disabled={busy} onClick={() => void perform(() => browse(chatType, page))}>更多会话</Button>}
        <div className="flex gap-2"><Input aria-label="会话 ID" placeholder="或输入会话 ID（oc_…）" value={manual} onChange={e => setManual(e.target.value)} /><Button disabled={busy || !view.running || !manual.trim()} onClick={() => void perform(async () => { await command('manual', manual.trim()); setManual(''); setTab('pending'); setNotice('已提交分析，请在待处理中查看进度。'); })}>分析</Button></div>
      </div>
    </details>
  </section>;
}

function JobDetail({ detail, latest, connected, running, command, onClose }: { detail: Detail; latest?: WorkbenchView['jobs'][number]; connected: boolean; running: boolean; command: Command; onClose: () => void }) {
  const [base, setBase] = useState(detail);
  const [draft, setDraft] = useState(detail.replyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = draft !== base.replyDraft;
  useEffect(() => {
    if (!dirty && latest?.detail && latest.revision !== base.revision) {
      setBase({ ...latest, ...latest.detail }); setDraft(latest.detail.replyDraft);
    }
  }, [latest, dirty, base.revision]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const review = async (patch: object) => {
    const result = await command('review', { id: base.id, revision: base.revision, ...patch }) as Detail;
    setBase(result); setDraft(result.replyDraft); setNotice('已保存');
  };
  return <div className="space-y-3 rounded-lg border-2 p-4">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium">{base.name}</h3><Button variant="ghost" onClick={onClose}>关闭详情</Button></div>
    {base.sourceUrl && <a className="text-sm text-primary underline" href={base.sourceUrl} target="_blank" rel="noreferrer">{base.sourceKind === 'conversation' ? '打开原会话' : '打开来源'}</a>}
    {base.evidenceDir && <p className="break-all text-xs text-muted-foreground">证据目录：{base.evidenceDir}</p>}
    <p className="whitespace-pre-wrap text-sm">{base.analysis || '尚无分析结果'}</p>
    {base.error && <p className="text-sm text-destructive">{base.error}</p>}
    {base.missingInfo && <p className="whitespace-pre-wrap text-sm">待确认：{base.missingInfo}</p>}
    {base.draftStale && <p className="text-sm text-amber-700">现有草稿待核对，请确认草稿或重新分析。</p>}
    {dirty && latest && latest.revision !== base.revision && <p className="text-sm text-amber-700">事项状态已变化，请核对最新内容。你的编辑仍保留。</p>}
    <label className="block text-sm">回复草稿<textarea className="mt-1 min-h-32 w-full rounded border bg-background p-2" value={draft} maxLength={6000} onChange={e => setDraft(e.target.value)} /></label>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || (!dirty && !base.draftStale) || !connected} onClick={() => void perform(() => review({ replyDraft: draft }))}>{!dirty && base.draftStale ? '确认草稿' : '保存草稿'}</Button>
      <Button variant="outline" disabled={busy || !draft} onClick={() => void perform(async () => { await navigator.clipboard.writeText(draft); setNotice('草稿已复制，请到原会话核对后发送。'); })}>复制草稿</Button>
      <Button variant="outline" disabled={busy || !running || dirty || ['running', 'queued'].includes(latest?.state || base.state)} onClick={() => void perform(async () => { await command('process', base.id); setNotice('已提交分析'); })}>分析 / 重试</Button>
      {(['handled', 'ignored', 'open'] as const).map(state => <Button key={state} variant="ghost" disabled={busy || !connected || dirty || base.handlingState === state} onClick={() => void perform(() => review({ handlingState: state }))}>{state === 'handled' ? '已处理' : state === 'ignored' ? '忽略' : '恢复待办'}</Button>)}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <details><summary className="cursor-pointer text-sm">近期消息摘录</summary>{base.messages.map((m, i) => <div key={i} className="mt-2 rounded border p-2 text-xs"><p>{m.name} · {new Date(m.time).toLocaleString()}</p><p className="whitespace-pre-wrap">{m.text}</p></div>)}</details>
  </div>;
}
