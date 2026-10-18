import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import type { DeviceLogin, ProfileInfo, UserAuthStatus } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { INBOX_MIN_POLL_SECONDS, intakeScope, type IntakeScope, type InboxConfig } from '../../../src/inbox/config';
import { InboxWorkbench, type WorkbenchView } from './InboxWorkbench';
import type { ModelServiceConfig } from '../../../src/model-service/config';

const scopes = ['search:message', 'im:chat:read', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user'];
type SetupCheck = { checks: { label: string; ok: boolean; detail: string }[]; ownerOpenId: string; ok: boolean };

export function InboxView({ servicesRevision = 0 }: { servicesRevision?: number }) {
  const [view, setView] = useState<WorkbenchView>();
  const [config, setConfig] = useState<InboxConfig>();
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [services, setServices] = useState<Record<string, ModelServiceConfig>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<SetupCheck>();
  const [login, setLogin] = useState<(DeviceLogin & { profile: string })>();
  const refresh = useCallback(async () => {
    const v = await apiGet<WorkbenchView>('/api/inbox/workbench');
    setView(v); setConfig(c => c ?? v.config);
  }, []);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try { if (active) await refresh(); } catch (e) { if (active) setError((e as Error).message); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    void apiGet<{ profiles: ProfileInfo[] }>('/api/profiles').then(v => setProfiles(v.profiles)).catch(e => setError(e.message));
    return () => { active = false; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => { void apiGet<{ services: Record<string, ModelServiceConfig> }>('/api/model-services')
    .then(result => { setServices(result.services); setChecks(undefined); }).catch(e => setError(e.message)); }, [servicesRevision]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const command = async (action: string, target: unknown) => {
    const result = await apiPost('/api/inbox/command', { id: crypto.randomUUID(), action, target: typeof target === 'string' ? target : JSON.stringify(target) });
    await refresh(); return result;
  };
  if (!config) return <p className="text-sm">{error || '加载会话助理…'}</p>;
  const change = (patch: Partial<InboxConfig>) => { setConfig({ ...config, ...patch }); setChecks(undefined); };
  const executor = profiles.find(p => p.name === config.executorProfile);
  const separateTriage = config.triageProfile && config.triageProfile !== config.executorProfile;
  const check = async () => {
    const result = await apiPost<SetupCheck>('/api/inbox/check', config);
    setChecks(result);
    if (!config.ownerOpenId && result.ownerOpenId) setConfig({ ...config, ownerOpenId: result.ownerOpenId });
  };
  return <Card className="mt-6" id="inbox"><CardHeader><CardTitle>会话助理</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">在本机整理待办、核对分析并编辑草稿。首次配置后手动开启；可选接入远程工作台。</p>
    <div className="flex flex-wrap items-center gap-3">
      <span>{view?.running ? '正在接收飞书消息' : '已暂停接收飞书消息'}；盯盘来源独立控制</span>
      {view?.connected && <Button disabled={busy} variant="outline" onClick={() => void perform(async () => {
        await command('mode', view.running ? 'off' : 'on');
        setConfig(c => c && ({ ...c, enabled: !view.running }));
      })}>{view.running ? '暂停接收' : '开启接收'}</Button>}
      <Button variant="ghost" disabled={busy} onClick={() => void perform(refresh)}>刷新</Button>
    </div>
    {(error || view?.error) && <p role="alert" className="text-sm text-destructive">{error || view?.error}</p>}
    {view && <InboxWorkbench view={view} command={command} />}
    <details open={!view?.config.executorProfile} className="rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">配置与首次使用检查</summary>
      <div className="mt-4 space-y-4">
        <p className="text-sm">1. 创建并启动个人 Claude 或 Codex profile。2. 授权读取飞书消息。3. 设置结果话题和模型。4. 检查后开启。</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>执行 profile<select className="mt-1 w-full rounded border bg-background p-2" value={config.executorProfile} onChange={e => change({ executorProfile: e.target.value,
            ...(profiles.find(p => p.name === e.target.value)?.agentKind !== executor?.agentKind ? { analysisModel: '' } : {}) })}>
            <option value="">请选择</option>{profiles.filter(p => p.capabilities?.backgroundAnalysis).map(p => <option key={p.name} value={p.name}>{p.name}（{p.agentKind}）</option>)}
          </select></label>
          <label>所属用户 Open ID<Input value={config.ownerOpenId} placeholder="授权检查后自动填写" onChange={e => change({ ownerOpenId: e.target.value })} /></label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || !config.executorProfile} onClick={() => void perform(async () => {
            await apiPost('/api/profiles/start', { profile: config.executorProfile }); await refresh();
          })}>启动执行 profile</Button>
          <Button variant="outline" disabled={busy || !config.executorProfile} onClick={() => void perform(async () => {
            const result = await apiPost<DeviceLogin>('/api/auth/login/start', { profile: config.executorProfile, scopes });
            setLogin({ ...result, profile: config.executorProfile });
          })}>授权飞书消息读取</Button>
          <Button variant="ghost" disabled={busy || !config.executorProfile} onClick={() => void perform(async () => {
            const auth = await apiGet<UserAuthStatus>(`/api/auth/status?profile=${encodeURIComponent(config.executorProfile)}`);
            if (!auth.openId) throw new Error('此 profile 尚无用户授权');
            change({ ownerOpenId: auth.openId });
          })}>读取已授权身份</Button>
        </div>
        {login && <div className="space-y-2 rounded border p-3 text-sm">
          <p>在浏览器中授权后，点击“完成授权”。</p>
          <a className="break-all text-primary underline" href={login.verificationUrl} target="_blank" rel="noreferrer">{login.verificationUrl}</a>
          <Button disabled={busy} onClick={() => void perform(async () => {
            await apiPost('/api/auth/login/complete', { profile: login.profile, deviceCode: login.deviceCode });
            await apiPost(`/api/config?profile=${encodeURIComponent(login.profile)}`, { larkCliIdentity: 'user-default' });
            const auth = await apiGet<UserAuthStatus>(`/api/auth/status?profile=${encodeURIComponent(login.profile)}`);
            if (config.executorProfile === login.profile && auth.openId) change({ ownerOpenId: auth.openId });
            setLogin(undefined);
          })}>完成授权</Button>
        </div>}
        <div className="grid gap-3 sm:grid-cols-2">
          {([['chatId', '结果群 ID'], ['threadId', '结果话题 ID'], ['replyTo', '话题内回复消息 ID']] as const).map(([key, label]) => <label key={key}>{label}<Input value={config.destination[key]} onChange={e => change({ destination: { ...config.destination, [key]: e.target.value } })} /></label>)}
          <label>深入分析模型<Input value={config.analysisModel ?? (executor?.agentKind === 'codex' ? 'deepseek-flash' : '')} placeholder="留空使用执行 profile 默认模型" onChange={e => change({ analysisModel: e.target.value })} /></label>
          <label>筛选模型服务<select className="mt-1 w-full rounded border bg-background p-2" value={config.triageService ?? ''} onChange={e => change({ triageService: e.target.value,
            ...(e.target.value ? { triageProfile: undefined, triageModel: '' } : {}) })}>
            <option value="">沿用旧版 profile 配置</option>{Object.entries(services).map(([name, service]) => <option key={name} value={name}>{name}（{service.model}）</option>)}
            {config.triageService && !services[config.triageService] && <option value={config.triageService}>{config.triageService}（未找到）</option>}
          </select></label>
          {!config.triageService && <label>旧版筛选 profile<select className="mt-1 w-full rounded border bg-background p-2" value={config.triageProfile ?? ''} onChange={e => change({ triageProfile: e.target.value })}>
            <option value="">跟随执行 profile</option>{profiles.filter(p => p.capabilities?.modelService).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select></label>}
          <label>筛选模型覆盖<Input value={config.triageModel ?? (config.triageService ? '' : separateTriage ? 'deepseek-flash' : config.analysisModel ?? 'deepseek-flash')}
            placeholder={config.triageService ? `留空使用 ${services[config.triageService]?.model || '服务默认模型'}` : '留空使用筛选 profile 默认模型'} onChange={e => change({ triageModel: e.target.value })} /></label>
        </div>
        <p className="text-xs text-muted-foreground">可在上方“模型 API 服务”中添加独立筛选服务，无需 Codex profile。选择旧版配置时继续读取对应 Codex 配置；仅有 Codex 网页登录授权不够。读取飞书消息始终使用执行 profile 的用户授权。</p>
        <p className="text-xs text-muted-foreground">授权后把机器人加入结果群，在目标话题发送 /inbox setup（按群设置 @ 机器人），然后点击“重新读取设置”即可自动填入三个 ID。</p>
        <Button variant="ghost" disabled={busy} onClick={() => void perform(async () => {
          const saved = await apiGet<{ config: InboxConfig }>('/api/inbox'); setConfig(saved.config); setChecks(undefined);
        })}>重新读取设置</Button>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={config.deliveryMode === 'new_topic'} onChange={e => change({ deliveryMode: e.target.checked ? 'new_topic' : 'thread' })} />每个事项新开结果话题（需话题群）</label>
        <fieldset className="flex flex-wrap gap-2"><legend className="mb-2 text-sm">接收范围</legend>{([['private', '私聊'], ['private_mentions', '私聊和 @ 我'], ['all', '全部']] as [IntakeScope, string][]).map(([value, label]) => <Button key={value} variant={intakeScope(config) === value ? 'secondary' : 'outline'} aria-pressed={intakeScope(config) === value} onClick={() => change({ intakeScope: value, watchPrivate: true, watchMentions: value !== 'private' })}>{label}</Button>)}</fieldset>
        <label className="block text-sm">本人职责与关注范围<textarea className="mt-1 min-h-24 w-full rounded border bg-background p-2" maxLength={3000} value={config.attentionProfile} onChange={e => change({ attentionProfile: e.target.value })} placeholder="填写你的职责、项目和需要关注的事项；留空使用通用筛选规则" /></label>
        <details><summary className="cursor-pointer text-sm">高级设置与可选远程入口</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
          {([['dailyTriageLimit', '每日筛选批次上限'], ['contextMinutes', '近期上下文分钟数'], ['pollSeconds', '消息采集间隔秒数（最短 5 秒）']] as const).map(([key, label]) => <label key={key}>{label}<Input type="number" min={key === 'pollSeconds' ? INBOX_MIN_POLL_SECONDS : undefined} max={key === 'pollSeconds' ? 3600 : undefined} value={config[key]} onChange={e => change({ [key]: Number(e.target.value) })} /></label>)}
          <label>远程工作台 URL<Input value={config.gui.publicUrl} onChange={e => change({ gui: { ...config.gui, publicUrl: e.target.value } })} /></label>
          <label>远程工作台凭证文件<Input value={config.gui.apiKeyFile} onChange={e => change({ gui: { ...config.gui, apiKeyFile: e.target.value } })} /></label>
          <label>独立 H5 入口 URL<Input value={config.h5.publicUrl} onChange={e => change({ h5: { ...config.h5, publicUrl: e.target.value } })} /></label>
          <label>独立 H5 端口<Input type="number" value={config.h5.port} onChange={e => change({ h5: { ...config.h5, port: Number(e.target.value) } })} /></label>
        </div></details>
        <label className="flex gap-2"><input type="checkbox" checked={config.enabled} onChange={e => change({ enabled: e.target.checked })} />保存后开启飞书消息采集</label>
        <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => void perform(check)}>检查配置</Button>
          <Button disabled={busy} onClick={() => void perform(async () => {
            let next = config;
            if (config.enabled) {
              const result = await apiPost<SetupCheck>('/api/inbox/check', config); setChecks(result);
              if (!result.ok) throw new Error('请先解决检查中未通过的项目');
              if (!config.ownerOpenId && result.ownerOpenId) next = { ...config, ownerOpenId: result.ownerOpenId };
            }
            const saved = await apiPost<{ config: InboxConfig }>('/api/inbox', next);
            setConfig(saved.config); await refresh();
          })}>保存配置</Button></div>
        {checks && <ul className="space-y-1 text-sm">{checks.checks.map(c => <li key={c.label} className={c.ok ? '' : 'text-destructive'}>{c.ok ? '✓' : '✗'} {c.label}：{c.detail}</li>)}</ul>}
      </div>
    </details>
  </CardContent></Card>;
}
