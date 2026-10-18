import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { InboxConfig } from '../inbox/config';
import { normalizeInbox, validateInbox } from '../inbox/config';
import { array, boolean, choice, fail, integer, string, table } from '../monitoring/validation';

export interface StorageCluster { id: string; datasource: string; database: string; minConnectedNodes: number }
export interface TaskPlatform { id: string; datasource: string }
export interface StorageWatch {
  id: string; kind: 'cluster' | 'user'; enabled: boolean;
  cluster?: string; platform?: string; uid?: number;
  /** Declared dependencies supplement clusters discovered from successful and failed I/O. */
  clusters: string[];
}
export interface StorageMonitorConfig {
  enabled: boolean; executorProfile: string; model: string; pollSeconds: number;
  windowSeconds: number; staleSeconds: number; sustainSeconds: number; recoverySeconds: number;
  reanalyzeSeconds: number; latencyMs: number; maxTasks: number; dailyAnalysisLimit: number; outputDir: string; muted: boolean;
  grafana: { url: string; credentialsFile: string };
  clusters: StorageCluster[]; platforms: TaskPlatform[]; watches: StorageWatch[];
  notification?: Pick<InboxConfig, 'ownerOpenId' | 'destination' | 'deliveryMode'>;
}
const schema = table({
  enabled: boolean, executorProfile: string, model: string, muted: boolean,
  pollSeconds: integer(15, 3600), windowSeconds: integer(30, 3600), staleSeconds: integer(30, 7200),
  sustainSeconds: integer(30, 86400), recoverySeconds: integer(30, 86400), reanalyzeSeconds: integer(60, 86400),
  dailyAnalysisLimit: integer(0, 1000), latencyMs: integer(0, 3_600_000), maxTasks: integer(1, 10000), outputDir: string,
  grafana: table({ url: string, credentialsFile: string }),
  clusters: array(table({ id: string, datasource: string, database: string, minConnectedNodes: integer(0, 100000) })),
  platforms: array(table({ id: string, datasource: string })),
  watches: array(table({ id: string, kind: choice('cluster', 'user'), enabled: boolean,
    cluster: string, platform: string, uid: integer(1, 2147483647), clusters: array(string) })),
  notification: table({ ownerOpenId: string, deliveryMode: choice('thread', 'new_topic'),
    destination: table({ chatId: string, threadId: string, replyTo: string }) }),
});

export function parseStorageConfig(value: unknown = {}): StorageMonitorConfig {
  schema(value, 'sources.storage');
  const raw = value as Partial<StorageMonitorConfig>;
  const config: StorageMonitorConfig = {
    enabled: false, executorProfile: '', model: 'deepseek-flash', pollSeconds: 60,
    windowSeconds: 120, staleSeconds: 180, sustainSeconds: 180, recoverySeconds: 180,
    reanalyzeSeconds: 600, latencyMs: 0, maxTasks: 1000, dailyAnalysisLimit: 24,
    outputDir: join(homedir(), '.lark-channel', 'storage-monitor', 'evidence'), muted: false,
    ...raw,
    grafana: { url: '', credentialsFile: join(homedir(), '.grafana.env'), ...raw.grafana },
    clusters: (raw.clusters ?? []).map(c => ({ ...c, minConnectedNodes: c.minConnectedNodes ?? 0 })),
    platforms: raw.platforms ?? [],
    watches: (raw.watches ?? []).map(w => ({ ...w, enabled: w.enabled ?? true, clusters: w.clusters ?? [] })),
  };
  const check = (ok: unknown, path: string, why: string) => { if (!ok) fail(`sources.storage.${path}`, why); };
  for (const name of ['clusters', 'platforms', 'watches'] as const) {
    const entries = config[name];
    check(entries.length <= (name === 'watches' ? 32 : 16), name, '来源数量超过上限（16 个集群/平台、32 个订阅）');
    check(new Set(entries.map(v => v.id)).size === entries.length, name, 'id 不可重复');
    for (const item of entries) check(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id ?? ''), name, '需要稳定的字母数字 id');
  }
  for (const c of config.clusters) {
    check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.database ?? ''), 'clusters.database', '需要数据库标识符');
    check(Boolean(c.datasource), 'clusters.datasource', '需要 Grafana datasource UID');
  }
  for (const p of config.platforms) check(Boolean(p.datasource), 'platforms.datasource', '需要 Grafana datasource UID');
  check(!config.grafana.credentialsFile || isAbsolute(config.grafana.credentialsFile), 'grafana.credentialsFile', '需要绝对路径');
  for (const w of config.watches) {
    check(['cluster', 'user'].includes(w.kind), 'watches.kind', '需要 cluster 或 user');
    if (w.kind === 'cluster') {
      check(config.clusters.some(c => c.id === w.cluster), 'watches.cluster', '集群未配置');
      check(!w.platform && w.uid === undefined && !w.clusters.length, 'watches', 'cluster 订阅仅填写 cluster');
    } else {
      check(config.platforms.some(p => p.id === w.platform), 'watches.platform', '平台未配置');
      check(!w.cluster, 'watches.cluster', '任务订阅请用 clusters 声明依赖');
      check(Number.isSafeInteger(w.uid) && Number(w.uid) > 0, 'watches.uid', '需要平台数字 UID');
      check(w.clusters.every(id => config.clusters.some(c => c.id === id)), 'watches.clusters', '依赖集群未配置');
    }
  }
  check(config.staleSeconds >= config.pollSeconds, 'staleSeconds', '不可短于轮询周期');
  check(isAbsolute(config.outputDir), 'outputDir', '需要绝对路径');
  check(Boolean(config.model.trim()), 'model', '需明确指定分析模型');
  if (config.grafana.url) {
    let url: URL | undefined; try { url = new URL(config.grafana.url); } catch { /* report field only */ }
    check(url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
      'grafana.url', '需要不含凭据的 HTTP(S) 地址');
  }
  if (config.enabled) {
    check(Boolean(config.executorProfile), 'executorProfile', '需要执行 profile');
    check(config.watches.some(w => w.enabled), 'watches', '需要至少一个启用的订阅');
    check(config.clusters.length > 0, 'clusters', '需要至少一个指标集群');
  }
  if (config.notification) {
    const n = normalizeInbox({ ...config.notification, enabled: true, executorProfile: config.executorProfile });
    validateInbox(n);
    config.notification = { ownerOpenId: n.ownerOpenId, destination: n.destination, deliveryMode: n.deliveryMode };
  }
  return config;
}
