import { useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MAX_WORK_ITEM_CONCURRENCY, type WorkItemConcurrency } from '../../../src/work-items/concurrency';
import type { WorkbenchView } from './InboxWorkbench';

export function WorkItemConcurrencyView({ config, revision, onSaved }: {
  config: WorkItemConcurrency; revision?: string; onSaved(): Promise<void>;
}) {
  const [draft, setDraft] = useState({ concurrency: config, concurrencyRevision: revision });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const perform = async (save: boolean) => {
    setBusy(true); setError('');
    try {
      const result = save ? await apiPost<WorkbenchView>('/api/inbox/concurrency', draft) : await apiGet<WorkbenchView>('/api/inbox');
      if (result.concurrency) setDraft({ concurrency: result.concurrency, concurrencyRevision: result.concurrencyRevision });
      await onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <details className="rounded-lg border p-4">
    <summary className="cursor-pointer font-medium">后台任务并发</summary>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {([['triage', '同时筛选事项数'], ['analysis', '同时深入分析事项数']] as const).map(([key, label]) =>
        <label key={key}>{label}<Input type="number" min={1} max={MAX_WORK_ITEM_CONCURRENCY} step={1} value={draft.concurrency[key]}
          onChange={e => setDraft({ ...draft, concurrency: { ...draft.concurrency, [key]: Number(e.target.value) } })} /></label>)}
    </div>
    <p className="mt-3 text-sm text-muted-foreground">默认同时筛选 50 个事项、深入分析 5 个事项。两类名额独立；每个事项单独执行，完成一个就补一个。飞书、GitLab CI 和存储告警的深入分析共用分析名额。</p>
    <p className="mt-2 text-sm text-muted-foreground">提高并发会增加模型请求量。保存后直接调整并发；降低时让已有任务完成，再按新上限补位。</p>
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    <div className="mt-3 flex gap-2">
      <Button disabled={busy} onClick={() => void perform(true)}>保存并发设置</Button>
      <Button variant="outline" disabled={busy} onClick={() => void perform(false)}>重新读取</Button>
    </div>
  </details>;
}
