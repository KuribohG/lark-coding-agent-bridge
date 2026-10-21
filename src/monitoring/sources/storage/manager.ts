import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { ExecutionProfile } from '../../../runtime/execution-provider';
import type { MonitorHost } from '../../host';
import { loadMonitorRoot } from '../../store';
import { WorkItemSources } from '../../../work-items/registry';
import { parseStorageConfig } from './config';
import { GrafanaQueryClient, grafanaCredentials } from './grafana';
import { GrafanaStorageProvider } from './provider';
import { storageInvestigator } from './investigation';
import { StorageMonitorService, storageScope } from './service';

export class StorageMonitorManager {
  private service?: StorageMonitorService;
  private connection?: Awaited<ReturnType<WorkItemSources['connect']>>;
  private unlock?: () => Promise<void>;
  private executor?: ExecutionProfile;
  private executionError?: string;
  private fingerprint = '';
  private chain = Promise.resolve();
  private timer: NodeJS.Timeout;
  private closed = false;
  error?: string;
  constructor(private configPath: string, private host: MonitorHost, private sources: WorkItemSources) {
    this.timer = setInterval(() => { void this.reconcile(); }, 15_000); this.timer.unref();
  }
  status() { return { error: this.error ?? this.service?.error, state: this.service?.state }; }
  reconcile(): Promise<void> {
    return this.chain = this.chain.then(() => this.reload()).catch(async e => {
      this.error = e instanceof Error ? e.message : '存储监控启动失败';
      if (this.service) await this.refreshExecutor(this.service.config.executorProfile);
    });
  }
  private async reload(): Promise<void> {
    if (this.closed) return;
    const root = await loadMonitorRoot(this.configPath);
    if (root) this.sources.configureConcurrency(root.workItemConcurrency);
    const config = parseStorageConfig(root?.storageMonitor);
    if (config.enabled) await this.refreshExecutor(config.executorProfile);
    else { this.executor = undefined; this.executionError = undefined; }
    const fingerprint = JSON.stringify(config);
    if (fingerprint === this.fingerprint) { this.error = this.executionError; return; }
    if (!config.executorProfile) { await this.stop(); this.error = undefined; return; }
    // Validate source credentials before replacing the last working instance.
    const enabled = config.enabled;
    const client = enabled ? new GrafanaQueryClient(await grafanaCredentials(config.grafana)) : { query: async () => { throw new Error('存储监控未启用'); } };
    const provider = new GrafanaStorageProvider(config, client);
    await this.stop();
    const folder = join(dirname(this.configPath), 'storage-monitor');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const lease = join(folder, 'service'); await writeFile(lease, '', { flag: 'a', mode: 0o600 });
    this.unlock = await lockfile.lock(lease, { stale: 60_000, update: 10_000, retries: 0, onCompromised: () => { void this.close(); } });
    try {
      this.connection = await this.sources.connect(this.host.source({ id: 'storage-monitor', label: '3FS / 萤火任务',
        dailyAnalysisLimit: config.dailyAnalysisLimit, resumeInterrupted: true,
        status: () => ({ error: this.error ?? this.service?.error, health: { checkedAt: this.service?.state.checkedAt,
          checks: Object.entries(this.service?.state.statuses ?? {}).map(([id, s]) => ({ id, ...s,
            state: !s.lastSuccessAt || Date.now() - s.lastSuccessAt > config.staleSeconds * 1000 ? 'unknown' : s.state })) } }),
        profile: config.executorProfile, enabled, executor: () => this.executor, model: config.model, reasoningEffort: 'max', sourceNotifications: true,
        notification: config.notification, muted: config.muted,
        driver: storageInvestigator(config, provider, () => this.service),
      }));
      this.fingerprint = fingerprint;
      if (!enabled) { this.error = this.executionError; return; }
      this.service = new StorageMonitorService(join(folder, `${storageScope(config)}.json`), config, provider, event => this.connection!.observe(event), Date.now, key => this.sources.isAnalyzing('storage-monitor', key));
      await this.service.start(); this.fingerprint = fingerprint; this.error = this.executionError;
    } catch (e) { await this.stop(); throw e; }
  }
  private async refreshExecutor(profile: string): Promise<void> {
    try {
      this.executor = await this.host.executors.resolve(profile);
      this.executionError = this.executor?.available ? undefined : this.executor?.error ?? '执行器暂不可用，采集继续，分析等待';
    } catch {
      this.executor = undefined; this.executionError = '执行器配置不可用，采集继续，分析等待';
    }
  }
  private async stop(): Promise<void> {
    await this.service?.close(); this.service = undefined;
    await this.connection?.close(); this.connection = undefined;
    await this.unlock?.(); this.unlock = undefined; this.fingerprint = '';
  }
  async close(): Promise<void> { this.closed = true; clearInterval(this.timer); await this.chain; await this.stop(); }
}
