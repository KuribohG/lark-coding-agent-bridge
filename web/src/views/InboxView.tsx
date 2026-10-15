import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { intakeScope, type IntakeScope, type InboxConfig } from '../../../src/inbox/config';

type View = { config: InboxConfig; running: boolean; error?: string; jobs: { id: string; state: string; source: { name: string } }[] };
export function InboxView() {
  const [view, setView] = useState<View>(); const [config, setConfig] = useState<InboxConfig>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void apiGet<View>('/api/inbox').then(v => { setView(v); setConfig(v.config); }).catch(e => setError(e.message)); }, []);
  if (!config) return error ? <p className="text-destructive">{error}</p> : null;
  const change = (patch: Partial<InboxConfig>) => setConfig({ ...config, ...patch });
  return <Card className="mt-6"><CardHeader><CardTitle>会话助理 · 全局设置</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">按接收范围整理新消息，轻量筛选需要关注的事项，点击后深入分析。最终由你发送。启用后在结果群任意话题发送 /inbox，即可打开工作台或卡片入口；是否需要 @ 机器人取决于该群的消息接收设置。</p>
    <label className="flex gap-2"><input type="checkbox" checked={config.enabled} onChange={e => change({ enabled: e.target.checked })} />开启会话助理</label>
    <label className="flex gap-2"><input type="checkbox" checked={config.deliveryMode === 'new_topic'} onChange={e => change({ deliveryMode: e.target.checked ? 'new_topic' : 'thread' })} />关注摘要在结果群新开话题（仅支持话题群）</label>
    <div className="grid gap-3 sm:grid-cols-2">
      {([['executorProfile', '执行 profile'], ['ownerOpenId', '本人 Open ID']] as const).map(([key, label]) => <label key={key}>{label}<Input value={config[key]} onChange={e => change({ [key]: e.target.value })} /></label>)}
      {([['chatId', '结果群 ID'], ['threadId', '结果话题 ID'], ['replyTo', '话题内回复消息 ID']] as const).map(([key, label]) => <label key={key}>{label}<Input value={config.destination[key]} onChange={e => change({ destination: { ...config.destination, [key]: e.target.value } })} /></label>)}
      <label>可选网页入口（留空使用飞书卡片）<Input placeholder="可留空；https://example.com/assistant/" value={config.h5.publicUrl} onChange={e => change({ h5: { ...config.h5, publicUrl: e.target.value } })} /></label>
      <label>可选网页服务端口<Input type="number" value={config.h5.port} onChange={e => change({ h5: { ...config.h5, port: Number(e.target.value) } })} /></label>
      {([['dailyTriageLimit', '每日轻量筛选批次上限'], ['contextMinutes', '近期上下文分钟数'], ['pollSeconds', '检测间隔秒数']] as const).map(([key, label]) => <label key={key}>{label}<Input type="number" value={config[key]} onChange={e => change({ [key]: Number(e.target.value) })} /></label>)}
    </div>
    <fieldset className="flex flex-wrap gap-3"><legend>接收范围</legend>{([['private', '私聊'], ['private_mentions', '私聊和 @ 我'], ['all', '全部']] as [IntakeScope, string][]).map(([value, label]) => <Button key={value} variant={intakeScope(config) === value ? 'secondary' : 'outline'} aria-pressed={intakeScope(config) === value} onClick={() => change({ intakeScope: value, watchPrivate: true, watchMentions: value !== 'private' })}>{label}</Button>)}</fieldset>
    <p className="text-sm">{view?.running ? '运行中' : '未运行'}{view?.error ? `：${view.error}` : ''}</p>
    {error && <p className="text-destructive">{error}</p>}
    <Button disabled={busy} onClick={() => { setBusy(true); void apiPost<View>('/api/inbox', config).then(v => { setView(v); setConfig(v.config); setError(''); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>保存全局设置</Button>
    {view?.jobs.slice(0, 5).map(j => <p key={j.id} className="text-sm">{j.source.name} · {j.state}</p>)}
  </CardContent></Card>;
}
