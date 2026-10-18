import type { StorageCluster, StorageMonitorConfig, StorageWatch } from './config';
import { numberField, sqlString, type QueryClient } from './grafana';

export interface TaskRun { id: string; chainId: string; user: string; status: string; nodes: string[]; pods: string[] }
export interface IoSample { pod: string; at: number; failures: number; chunks: number; latencyMs?: number }
export interface ClusterSample { id: string; at: number; connectedNodes: number; io: IoSample[] }
export interface StorageProvider {
  cluster(cluster: StorageCluster, signal: AbortSignal): Promise<ClusterSample>;
  tasks(watch: StorageWatch, tracked: string[], since: number, signal: AbortSignal): Promise<TaskRun[]>;
}
const strings = (value: unknown): string[] => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw new Error('平台列表字段无效'); } }
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('平台列表字段无效');
  return value;
};

export class GrafanaStorageProvider implements StorageProvider {
  constructor(private config: StorageMonitorConfig, private client: QueryClient, private now = Date.now) {}
  async cluster(cluster: StorageCluster, signal: AbortSignal): Promise<ClusterSample> {
    const db = cluster.database; const window = this.config.windowSeconds;
    const rows = await this.client.query(cluster.datasource, 'clickhouse', `
SELECT pod, max(toUnixTimestamp(TIMESTAMP)) AS at,
 sumIf(val, metricName = 'storage_client.num_failed_ops_per_user') AS failures,
 sumIf(val, metricName = 'storage_client.num_processed_chunks_per_user') AS chunks
FROM ${db}.counters WHERE TIMESTAMP > now() - INTERVAL ${window} SECOND
 AND metricName IN ('storage_client.num_failed_ops_per_user', 'storage_client.num_processed_chunks_per_user')
GROUP BY pod LIMIT 20001`, signal);
    if (rows.length > 20000) throw new Error('3FS 指标超过采集上限，覆盖不完整');
    const io = rows.map(row => ({ pod: String(row.pod ?? ''), at: numberField(row, 'at') * 1000,
      failures: numberField(row, 'failures'), chunks: numberField(row, 'chunks') } as IoSample));
    if (this.config.latencyMs) {
      const latency = await this.client.query(cluster.datasource, 'clickhouse', `
SELECT pod, sum(count * mean) / nullIf(sum(count), 0) / 1000000 AS latency
FROM ${db}.distributions WHERE TIMESTAMP > now() - INTERVAL ${window} SECOND
 AND metricName = 'storage_client.overall_latency'
GROUP BY pod HAVING sum(count) > 0 LIMIT 20001`, signal);
      if (latency.length > 20000) throw new Error('3FS 延迟指标超过采集上限');
      const byPod = new Map(io.map(s => [s.pod, s]));
      for (const row of latency) { const sample = byPod.get(String(row.pod)); if (sample) sample.latencyMs = numberField(row, 'latency'); }
    }
    const health = await this.client.query(cluster.datasource, 'clickhouse', `
SELECT max(at) AS at, sum(nodes) AS connected FROM (
 SELECT instance, argMax(val, TIMESTAMP) AS nodes, max(toUnixTimestamp(TIMESTAMP)) AS at
 FROM ${db}.counters WHERE TIMESTAMP > now() - INTERVAL ${window} SECOND
 AND metricName = 'MgmtdService.NodeStatusCount' AND tag = 'HEARTBEAT_CONNECTED'
 GROUP BY instance)`, signal);
    if (health.length !== 1) throw new Error('3FS 心跳指标缺失');
    return { id: cluster.id, at: numberField(health[0]!, 'at') * 1000,
      connectedNodes: numberField(health[0]!, 'connected'), io };
  }
  async tasks(watch: StorageWatch, tracked: string[], since: number, signal: AbortSignal): Promise<TaskRun[]> {
    const platform = this.config.platforms.find(p => p.id === watch.platform);
    if (!platform) throw new Error('任务平台未配置');
    const limit = this.config.maxTasks;
    if (tracked.length > limit) throw new Error('跟踪 Chain 超过上限');
    // Archive and active tables can overlap. Use the real chain_id, retaining the highest run ID.
    const seconds = Math.max(3600, Math.ceil((this.now() - since) / 1000) + 3600);
    if (!Number.isSafeInteger(watch.uid)) throw new Error('平台 UID 无效');
    const users = await this.client.query(platform.datasource, 'postgres',
      `SELECT user_name FROM "user" WHERE user_id = ${watch.uid} LIMIT 2`, signal);
    if (users.length !== 1 || typeof users[0]!.user_name !== 'string') throw new Error('UID 未找到或无权查看');
    const user = users[0]!.user_name;
    const owner = `user_name = ${sqlString(user)}`;
    const recent = ` AND (created_at >= CURRENT_TIMESTAMP - INTERVAL '${seconds} seconds'${tracked.length ? ` OR chain_id IN (${tracked.map(sqlString).join(',')})` : ''})`;
    const rows = await this.client.query(platform.datasource, 'postgres', `
WITH runs AS (
 SELECT id, chain_id, user_name, queue_status, assigned_nodes FROM task_ng WHERE ${owner}${recent}
 UNION ALL SELECT id, chain_id, user_name, queue_status, assigned_nodes FROM unfinished_task_ng WHERE ${owner}
), latest AS (
 SELECT DISTINCT ON (chain_id) * FROM runs WHERE chain_id IS NOT NULL ORDER BY chain_id, id DESC
)
SELECT t.id::text AS id, t.chain_id, t.user_name, t.queue_status,
 coalesce(to_json(t.assigned_nodes), '[]'::json) AS nodes,
 coalesce((SELECT json_agg(p.pod_id) FROM pod_ng p WHERE p.task_id=t.id), '[]'::json) AS pods
FROM latest t ORDER BY t.id DESC LIMIT ${limit + 1}`, signal);
    if (rows.length > limit) throw new Error('任务发现超过 maxTasks，未将截断结果当作完整列表');
    return rows.map(row => {
      if (!/^\d+$/.test(String(row.id)) || typeof row.chain_id !== 'string' || !row.chain_id || typeof row.user_name !== 'string' || typeof row.queue_status !== 'string') throw new Error('平台任务身份字段无效');
      if (row.user_name !== user) throw new Error('平台返回了订阅范围外的任务');
      return { id: String(row.id), chainId: row.chain_id, user: row.user_name, status: row.queue_status,
        nodes: strings(row.nodes), pods: strings(row.pods) };
    });
  }
}
