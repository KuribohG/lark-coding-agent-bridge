import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { Controls } from '../../../commands';
import { resolveAppPaths } from '../../../config/app-paths';
import { loadMonitorRoot } from '../../store';
import { supportsBackgroundProfile } from '../../../runtime/agent-capabilities';
import { backgroundModelSettings } from '../../../runtime/background-model';
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
  private fingerprint = '';
  private chain = Promise.resolve();
  private timer: NodeJS.Timeout;
  private closed = false;
  error?: string;
  constructor(private configPath: string, private controls: (profile: string) => Controls | undefined,
    private rootDir: string | undefined, private sources: WorkItemSources) {
    this.timer = setInterval(() => { void this.reconcile(); }, 15_000); this.timer.unref();
  }
  status() { return { error: this.error ?? this.service?.error, state: this.service?.state }; }
  reconcile(): Promise<void> {
    return this.chain = this.chain.then(() => this.reload()).catch(async e => {
      this.error = e instanceof Error ? e.message : '存储监控启动失败';
      const controls = this.service && this.controls(this.service.config.executorProfile);
      if (this.service && (!controls || !supportsBackgroundProfile(controls.profileConfig))) await this.stop();
    });
  }
  private async reload(): Promise<void> {
    if (this.closed) return;
    const config = parseStorageConfig((await loadMonitorRoot(this.configPath))?.storageMonitor);
    const controls = this.controls(config.executorProfile);
    const fingerprint = JSON.stringify([config, controls?.profileConfig, controls?.botIdentity]);
    if (fingerprint === this.fingerprint) { this.error = config.enabled && !controls ? '存储监控执行 profile 离线' : undefined; return; }
    if (!config.executorProfile) { await this.stop(); this.error = undefined; return; }
    if (controls && !supportsBackgroundProfile(controls.profileConfig)) throw new Error('存储监控需要支持后台分析的个人 profile');
    // Validate credentials/model before replacing the last working instance.
    const enabled = config.enabled && Boolean(controls);
    const client = enabled ? new GrafanaQueryClient(await grafanaCredentials(config.grafana)) : { query: async () => { throw new Error('存储监控未启用'); } };
    const provider = new GrafanaStorageProvider(config, client);
    const paths = resolveAppPaths({ rootDir: this.rootDir, profile: config.executorProfile });
    const settings = controls && enabled ? await backgroundModelSettings(controls.profileConfig, paths.profileDir, config.model, 'max') : {};
    await this.stop();
    const folder = join(dirname(this.configPath), 'storage-monitor');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const lease = join(folder, 'service'); await writeFile(lease, '', { flag: 'a', mode: 0o600 });
    this.unlock = await lockfile.lock(lease, { stale: 60_000, update: 10_000, retries: 0, onCompromised: () => { void this.close(); } });
    try {
      this.connection = await this.sources.connect({ id: 'storage-monitor', label: '3FS / 萤火任务',
        dailyAnalysisLimit: config.dailyAnalysisLimit, resumeInterrupted: true,
        status: () => ({ error: this.error ?? this.service?.error, health: { checkedAt: this.service?.state.checkedAt,
          checks: Object.entries(this.service?.state.statuses ?? {}).map(([id, s]) => ({ id, ...s,
            state: !s.lastSuccessAt || Date.now() - s.lastSuccessAt > config.staleSeconds * 1000 ? 'unknown' : s.state })) } }),
        profile: config.executorProfile, enabled, controls, settings, lane: 'incident', sourceNotifications: true,
        notification: config.notification, muted: config.muted,
        driver: storageInvestigator(config, provider, () => this.service),
      });
      this.fingerprint = fingerprint;
      if (!enabled) { this.error = config.enabled ? '存储监控执行 profile 离线' : undefined; return; }
      this.service = new StorageMonitorService(join(folder, `${storageScope(config)}.json`), config, provider, event => this.connection!.observe(event), Date.now, key => this.sources.isAnalyzing('storage-monitor', key));
      await this.service.start(); this.fingerprint = fingerprint; this.error = undefined;
    } catch (e) { await this.stop(); throw e; }
  }
  private async stop(): Promise<void> {
    await this.service?.close(); this.service = undefined;
    await this.connection?.close(); this.connection = undefined;
    await this.unlock?.(); this.unlock = undefined; this.fingerprint = '';
  }
  async close(): Promise<void> { this.closed = true; clearInterval(this.timer); await this.chain; await this.stop(); }
}
