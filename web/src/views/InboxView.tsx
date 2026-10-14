import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { InboxConfig } from '../../../src/inbox/config';

type View = { config: InboxConfig; running: boolean; error?: string; jobs: { id: string; state: string; source: { name: string } }[] };
export function InboxView() {
  const [view, setView] = useState<View>(); const [config, setConfig] = useState<InboxConfig>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void apiGet<View>('/api/inbox').then(v => { setView(v); setConfig(v.config); }).catch(e => setError(e.message)); }, []);
  if (!config) return error ? <p className="text-destructive">{error}</p> : null;
  const change = (patch: Partial<InboxConfig>) => setConfig({ ...config, ...patch });
  return <Card className="mt-6"><CardHeader><CardTitle>会话助理 · 全局设置</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">自动整理私聊和直接 @ 你的消息，在指定群话题准备分析与回复草稿。最终由你发送。</p>
    <label className="flex gap-2"><input type="checkbox" checked={config.enabled} onChange={e => change({ enabled: e.target.checked })} />开启会话助理</label>
    <div className="grid gap-3 sm:grid-cols-2">
      {([['executorProfile', '执行 profile'], ['ownerOpenId', '本人 Open ID']] as const).map(([key, label]) => <label key={key}>{label}<Input value={config[key]} onChange={e => change({ [key]: e.target.value })} /></label>)}
      {([['chatId', '结果群 ID'], ['threadId', '结果话题 ID'], ['replyTo', '话题内回复消息 ID']] as const).map(([key, label]) => <label key={key}>{label}<Input value={config.destination[key]} onChange={e => change({ destination: { ...config.destination, [key]: e.target.value } })} /></label>)}
      <label>助理页面 HTTPS 地址<Input placeholder="https://example.com/assistant/" value={config.h5.publicUrl} onChange={e => change({ h5: { ...config.h5, publicUrl: e.target.value } })} /></label>
      <label>助理服务端口<Input type="number" value={config.h5.port} onChange={e => change({ h5: { ...config.h5, port: Number(e.target.value) } })} /></label>
      {([['waitMinutes', '等待分钟数'], ['dailyAutoLimit', '每日自动任务上限'], ['contextMinutes', '近期上下文分钟数'], ['pollSeconds', '检测间隔秒数']] as const).map(([key, label]) => <label key={key}>{label}<Input type="number" value={config[key]} onChange={e => change({ [key]: Number(e.target.value) })} /></label>)}
    </div>
    <div className="flex flex-wrap gap-4">{([['watchPrivate', '监听私聊'], ['watchMentions', '监听直接 @'], ['autoAnalyze', '超时自动分析']] as const).map(([key, label]) => <label key={key} className="flex gap-2"><input type="checkbox" checked={config[key]} onChange={e => change({ [key]: e.target.checked })} />{label}</label>)}</div>
    <p className="text-sm">{view?.running ? '运行中' : '未运行'}{view?.error ? `：${view.error}` : ''}</p>
    {error && <p className="text-destructive">{error}</p>}
    <Button disabled={busy} onClick={() => { setBusy(true); void apiPost<View>('/api/inbox', config).then(v => { setView(v); setConfig(v.config); setError(''); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>保存全局设置</Button>
    {view?.jobs.slice(0, 5).map(j => <p key={j.id} className="text-sm">{j.source.name} · {j.state}</p>)}
  </CardContent></Card>;
}
