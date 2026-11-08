import { join } from 'node:path';
import type { MonitorHost } from '../../host';
import { SourceController, type SourceKind } from '../../source-controller';
import type { WorkItemSources } from '../../../work-items/registry';
import { parseStorageConfig, type StorageMonitorConfig } from './config';
import { GrafanaQueryClient, grafanaCredentials } from './grafana';
import { GrafanaStorageProvider } from './provider';
import { storageInvestigator } from './investigation';
import { StorageMonitorService, storageScope, type StorageState } from './service';

const storageKind: SourceKind<StorageMonitorConfig, StorageMonitorService> = {
  id: 'storage-monitor', label: '3FS / 萤火任务', section: 'storage', folder: 'storage-monitor',
  logTag: 'storage-monitor', setupError: '存储监控启动失败',
  config: root => parseStorageConfig(root?.storageMonitor),
  describe: config => ({ clusters: config.clusters.map(c => c.id), model: config.model }),
  async setup(config, sources) {
    const client = config.enabled ? new GrafanaQueryClient(await grafanaCredentials(config.grafana))
      : { query: async () => { throw new Error('存储监控未启用'); } };
    const provider = new GrafanaStorageProvider(config, client);
    return {
      options: view => ({
        dailyAnalysisLimit: config.dailyAnalysisLimit, resumeInterrupted: true,
        status: () => {
          const current = view.collector();
          return { error: view.error() ?? current?.error, health: { checkedAt: current?.state.checkedAt,
            checks: Object.entries(current?.state.statuses ?? {}).map(([id, s]) => ({ id, ...s,
              state: !s.lastSuccessAt || Date.now() - s.lastSuccessAt > config.staleSeconds * 1000 ? 'unknown' : s.state })) } };
        },
        model: config.model, reasoningEffort: 'max', sourceNotifications: true,
        notification: config.notification, muted: config.muted,
        driver: storageInvestigator(config, provider, view.collector),
      }),
      start: config.enabled ? async (connection, folder) => {
        const service = new StorageMonitorService(config, provider, connection.journal<StorageState>(), Date.now,
          key => sources.isAnalyzing('storage-monitor', key), join(folder, `${storageScope(config)}.json`));
        await service.start();
        return service;
      } : undefined,
    };
  },
};

export class StorageMonitorManager extends SourceController<StorageMonitorConfig, StorageMonitorService> {
  constructor(configPath: string, host: MonitorHost, sources: WorkItemSources) {
    super(storageKind, configPath, host, sources);
  }
  status() { return { error: this.error ?? this.current?.error, state: this.current?.state }; }
}
