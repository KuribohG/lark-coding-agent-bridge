import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ModelProtocol, ModelSecretRef, ModelServiceConfig } from '../../../src/model-service/config';

type Services = Record<string, ModelServiceConfig>;
const empty = { contextWindow: '', protocol: 'responses' as ModelProtocol, endpoints: '', name: '', baseUrl: '', model: '', source: 'env' as ModelSecretRef['source'], id: '', headers: '' };

export function ModelServicesView({ onChange }: { onChange: () => void }) {
  const [services, setServices] = useState<Services>({});
  const [draft, setDraft] = useState(empty);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { void apiGet<{ services: Services }>('/api/model-services')
    .then(result => setServices(result.services)).catch(e => setError(e.message)); }, []);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const update = (result: { services: Services }) => { setServices(result.services); onChange(); };
  return <Card className="mt-6" id="model-services"><CardHeader><CardTitle>模型 API 服务</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">独立配置筛选、分类和摘要使用的模型 API。支持 Responses 和 Gemini 原生接口；同一服务可为不同后端配置独立的协议入口。</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {Object.entries(services).map(([name, config]) => <div key={name} className="rounded border p-3 text-sm">
      <p className="font-medium">{name} · {config.model}</p><p className="break-all text-muted-foreground">{config.baseUrl}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => {
          setEditing(true); setDraft({ name, contextWindow: config.contextWindow?.toString() ?? '', protocol: config.protocol, endpoints: config.endpoints ? JSON.stringify(config.endpoints, null, 2) : '', baseUrl: config.baseUrl, model: config.model, ...config.apiKey,
            headers: config.headers ? JSON.stringify(config.headers, null, 2) : '' });
        }}>编辑</Button>
        <Button variant="outline" disabled={busy} onClick={() => void perform(async () => {
          const result = await apiPost<{ note: string }>('/api/model-services/check', { name }); setNotice(result.note);
        })}>检查本地配置</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void perform(async () => {
          update(await apiPost<{ services: Services }>('/api/model-services/remove', { name }));
          if (draft.name === name) { setDraft(empty); setEditing(false); }
        })}>删除</Button>
      </div>
    </div>)}
    <details open={editing || Object.keys(services).length === 0} className="rounded border p-3">
      <summary className="cursor-pointer text-sm font-medium">{editing ? `编辑 ${draft.name}` : '添加模型服务'}</summary>
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <label>默认协议<select className="mt-1 w-full rounded border bg-background p-2" value={draft.protocol} onChange={e => setDraft({ ...draft, protocol: e.target.value as ModelProtocol })}><option value="responses">Responses</option><option value="gemini">Gemini 原生 API</option></select></label>
        <label>服务名称<Input disabled={editing || busy} value={draft.name} placeholder="screening" onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>上下文窗口（tokens，可选）<Input type="number" value={draft.contextWindow} placeholder="自定义 Antigravity 模型需要填写" onChange={e => setDraft({ ...draft, contextWindow: e.target.value })} /></label>
        <label>默认模型<Input value={draft.model} placeholder="服务商提供的模型 ID" onChange={e => setDraft({ ...draft, model: e.target.value })} /></label>
        <label className="sm:col-span-2">API 根地址<Input value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
        <label>API Key 来源<select className="mt-1 w-full rounded border bg-background p-2" value={draft.source} onChange={e => setDraft({ ...draft, source: e.target.value as ModelSecretRef['source'], id: '' })}>
          <option value="env">环境变量</option><option value="file">本机文件</option>
        </select></label>
        <label>{draft.source === 'env' ? '环境变量名' : '凭据文件绝对路径'}<Input value={draft.id} placeholder={draft.source === 'env' ? 'MODEL_API_KEY' : '/absolute/path/model-api-key'} onChange={e => setDraft({ ...draft, id: e.target.value })} /></label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">此处填写引用位置，密钥内容保留在本机。Responses 地址使用 /responses；Gemini 地址填写服务商的原生 API 根地址。保存和检查不会请求模型。</p>
      <details className="mt-3 text-sm"><summary className="cursor-pointer">其他协议入口（可选）</summary>
        <p className="mt-2 text-xs text-muted-foreground">可为同一 provider 的 gemini 或 responses 协议设置独立 baseUrl、默认 model 和 contextWindow，复用上方的凭据引用。</p>
        <textarea className="mt-2 min-h-20 w-full rounded border bg-background p-2 font-mono" value={draft.endpoints} placeholder={'{"gemini":{"baseUrl":"https://api.example.com","model":"gemini-model"}}'} onChange={e => setDraft({ ...draft, endpoints: e.target.value })} />
      </details>
      <details className="mt-3 text-sm"><summary className="cursor-pointer">额外请求头（可选）</summary>
        <p className="mt-2 text-xs text-muted-foreground">JSON 对象，每个值使用与 API Key 相同的 source / id 引用格式。鉴权请求头按协议和 API Key 自动设置。</p>
        <textarea className="mt-2 min-h-20 w-full rounded border bg-background p-2 font-mono" value={draft.headers} onChange={e => setDraft({ ...draft, headers: e.target.value })} />
      </details>
      <div className="mt-3 flex gap-2"><Button disabled={busy} onClick={() => void perform(async () => {
        let headers: unknown;
        try { headers = draft.headers.trim() ? JSON.parse(draft.headers) : undefined; }
        catch { throw new Error('额外请求头须为 JSON 格式的凭据引用'); }
        let endpoints: unknown;
        try { endpoints = draft.endpoints.trim() ? JSON.parse(draft.endpoints) : undefined; }
        catch { throw new Error('协议入口须为 JSON 对象'); }
        const config = { protocol: draft.protocol, ...(draft.contextWindow ? { contextWindow: Number(draft.contextWindow) } : {}), ...(endpoints === undefined ? {} : { endpoints }), baseUrl: draft.baseUrl, model: draft.model,
          apiKey: { source: draft.source, id: draft.id }, ...(headers === undefined ? {} : { headers }) };
        update(await apiPost<{ services: Services }>('/api/model-services', { name: draft.name, config }));
        setDraft(empty); setEditing(false); setNotice('模型服务已保存，可在会话助理中选择。');
      })}>保存模型服务</Button>
        {editing && <Button variant="ghost" disabled={busy} onClick={() => { setDraft(empty); setEditing(false); }}>取消编辑</Button>}
      </div>
    </details>
  </CardContent></Card>;
}
