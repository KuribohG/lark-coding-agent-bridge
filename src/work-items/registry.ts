import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { WorkItemConfig } from './config';
import type { SourceAdapter, WorkItemRuntime } from './contracts';
import { WorkItemService } from './service';
import { WorkItemStore } from './store';
import { WorkItemScheduler } from './scheduler';
import { parseWorkItemConcurrency, WORK_ITEM_CONCURRENCY_DEFAULTS } from './concurrency';
import type { WorkItemEvent } from './events';

export interface WorkItemSourceOptions {
  id: string; label: string;
  config: WorkItemConfig;
  source: SourceAdapter;
  runtime: Omit<WorkItemRuntime, 'source'>;
  status?: () => { error?: string; health?: { checkedAt?: number; checks: { id: string; state: string; detail: string; lastSuccessAt?: number }[] } };
}
interface Entry { service: WorkItemService; label: string; status?: WorkItemSourceOptions['status']; close(): Promise<void> }

/** Source/account partitions share lifecycle code, per-kind execution queues and the workbench. */
export class WorkItemSources {
  readonly triageQueue = new WorkItemScheduler(WORK_ITEM_CONCURRENCY_DEFAULTS.triage);
  private entries = new Map<string, Entry>();
  constructor(private configPath: string, readonly queue = new WorkItemScheduler()) {}
  get concurrency() { return { analysis: this.queue.concurrency, triage: this.triageQueue.concurrency }; }
  configureConcurrency(input: unknown): void {
    const config = parseWorkItemConcurrency(input);
    this.queue.resize(config.analysis); this.triageQueue.resize(config.triage);
  }
  isAnalyzing(id: string, key: string): boolean { return this.entries.get(id)?.service.store.data.jobs.some(j => j.external?.key === key && j.state === 'running') ?? false; }
  list(limit = 500) { return [...this.entries.values()].flatMap(entry => entry.service.list(limit)); }
  statuses() { return [...this.entries].map(([id, entry]) => {
    const status = entry.status?.();
    return { id, label: entry.label, running: entry.service.config.enabled, ...status, error: status?.error ?? entry.service.lastError };
  }); }
  async connect(options: WorkItemSourceOptions) {
    if (!/^[a-z][a-z0-9-]*$/.test(options.id)) throw new Error('Invalid inbox task source');
    if (options.source.id !== options.id) throw new Error('Invalid source adapter');
    if (this.entries.has(options.id)) throw new Error('Inbox task source already connected');
    const config = options.config;
    const scope = createHash('sha256').update(JSON.stringify([config.ownerKey, config.executorProfile])).digest('hex').slice(0, 24);
    const folder = join(dirname(this.configPath), 'inbox', 'sources', options.id, scope);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const lease = join(folder, 'service'); await writeFile(lease, '', { flag: 'a', mode: 0o600 });
    let service: WorkItemService | undefined;
    const unlock = await lockfile.lock(lease, { stale: 60_000, update: 10_000, retries: 0,
      onCompromised: () => { void service?.close(); } });
    try {
      service = new WorkItemService(new WorkItemStore(join(folder, 'state.json')), config,
        { ...options.runtime, source: options.source }, Date.now, this.queue, this.triageQueue);
      await service.start();
      const active = service;
      let closed = false;
      const entry: Entry = { service, label: options.label, status: options.status, close: async () => {
        if (closed) return; closed = true;
        if (this.entries.get(options.id) === entry) this.entries.delete(options.id);
        try { await active.close(); } finally { await unlock(); }
      } };
      this.entries.set(options.id, entry);
      return { submit: (event: WorkItemEvent) => active.observe(event), observe: (event: WorkItemEvent) => active.observe(event), close: entry.close };
    } catch (error) { try { await service?.close(); } finally { await unlock(); } throw error; }
  }
  select(ids: readonly string[], scope?: { owner: string; profile: string }): WorkItemService | undefined {
    const entries = [...this.entries.values()].filter(entry => ids.some(id => typeof id === 'string' && entry.service.get(id)));
    if (!entries.length) return undefined;
    if (scope && entries.some(entry => {
      const config = entry.service.config;
      return config.ownerKey !== scope.owner || config.executorProfile !== scope.profile;
    })) {
      throw new Error('待办不属于当前工作台');
    }
    if (entries.length !== 1 || !ids.every(id => typeof id === 'string' && entries[0]!.service.get(id))) {
      throw new Error('请按同一来源分别批量操作；本次未修改任何事项');
    }
    return entries[0]!.service;
  }
  async close() { await Promise.all([...this.entries.values()].map(entry => entry.close())); }
}
