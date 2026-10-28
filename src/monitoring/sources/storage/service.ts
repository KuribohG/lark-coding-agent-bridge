import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../../platform/atomic-write';
import type { WorkItemEvent } from '../../../work-items/events';
import type { StorageMonitorConfig, StorageWatch } from './config';
import type { ClusterSample, IoSample, StorageProvider, TaskRun } from './provider';

export const storageScope = (c: StorageMonitorConfig) => createHash('sha256').update(JSON.stringify([
  c.executorProfile, c.notification?.recipientKey, c.grafana.url, c.clusters, c.platforms,
  c.watches.filter(w => w.enabled), c.latencyMs, c.windowSeconds, c.sustainSeconds,
])).digest('hex').slice(0, 24);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
export interface CoverageStatus {
  state: 'healthy' | 'alert' | 'unknown' | 'idle' | 'pending';
  checkedAt: number; lastSuccessAt?: number; detail: string;
}
export interface IncidentEvidence {
  scope: string; cluster: string; at: number; sampleAt: number; reasons: string[];
  failures: number; connectedNodes: number; tasks: (TaskRun & { watches: string[] })[];
  coverage: string[];
}
interface Incident {
  key: string; cluster: string; open: boolean; revision: number; lastEmittedAt: number;
  signature: string; triggerReasons?: string[]; sampleAt: number; suspectSince?: number; healthySince?: number;
  evidence?: IncidentEvidence; event?: WorkItemEvent;
}
interface Tracked { run: TaskRun; history: string[]; seenAt: number; dependencies?: string[] }
export interface StorageState {
  version: 1; scope: string; checkedAt?: number;
  statuses: Record<string, CoverageStatus>;
  tasks: Record<string, { scannedAt: number; chains: Record<string, Tracked> }>;
  incidents: Record<string, Incident>;
}

/** Deterministic collector. Persist an observation before submitting it, then replay until acknowledged. */
export class StorageMonitorService {
  state: StorageState;
  private timer?: NodeJS.Timeout;
  private controller = new AbortController();
  private polling?: Promise<void>;
  private halted = false;
  error?: string;
  constructor(readonly path: string, readonly config: StorageMonitorConfig, private provider: StorageProvider,
    private submit: (event: WorkItemEvent) => Promise<unknown>, private now = Date.now, private analysisBusy = (_key: string) => false) {
    this.state = { version: 1, scope: storageScope(config), statuses: {}, tasks: {}, incidents: {} };
  }
  async start(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as StorageState;
      if (saved.version !== 1 || !saved.incidents || !saved.tasks || !saved.statuses) throw new Error('存储监控状态无效');
      if (saved.scope === this.state.scope) this.state = saved;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await this.save();
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.config.pollSeconds * 1000);
    this.timer.unref();
  }
  async close(): Promise<void> { clearInterval(this.timer); this.controller.abort(); await this.polling; }
  poll(): Promise<void> {
    if (this.controller.signal.aborted || this.halted) return Promise.resolve();
    return this.polling ??= this.collect().catch(error => {
      if (!this.controller.signal.aborted) this.error = error instanceof Error ? error.message : '存储监控采集失败';
    }).finally(() => { this.polling = undefined; });
  }
  private async save(): Promise<void> {
    try { await writeFileAtomic(this.path, JSON.stringify(this.state), { mode: 0o600 }); }
    catch (error) { this.halted = true; throw error; }
  }
  private async flush(): Promise<void> {
    for (const incident of Object.values(this.state.incidents)) if (incident.event) {
      this.controller.signal.throwIfAborted();
      await this.submit(incident.event);
      incident.event = undefined; await this.save();
    }
  }
  private status(id: string, state: CoverageStatus['state'], detail: string, success = true): void {
    const old = this.state.statuses[id];
    this.state.statuses[id] = { state, detail, checkedAt: this.now(),
      ...(success ? { lastSuccessAt: this.now() } : old?.lastSuccessAt ? { lastSuccessAt: old.lastSuccessAt } : {}) };
  }
  private fresh(at: number): boolean { return at > 0 && at <= this.now() + 30_000 && this.now() - at <= this.config.staleSeconds * 1000; }
  private async collect(): Promise<void> {
    await this.flush();
    const signal = this.controller.signal; const watches = this.config.watches.filter(w => w.enabled);
    const samples = new Map<string, ClusterSample>();
    // One failure does not suppress other clusters or platforms. Requests remain bounded.
    await Promise.all(this.config.clusters.map(async cluster => {
      try {
        const sample = await this.provider.cluster(cluster, signal);
        if (sample.id !== cluster.id || !this.fresh(sample.at)) throw new Error('心跳指标过期或身份不符');
        samples.set(cluster.id, sample);
        const hasIo = sample.io.some(v => this.fresh(v.at));
        this.status(`cluster:${cluster.id}`, hasIo ? 'healthy' : 'unknown', hasIo ? '已取得新鲜心跳与客户端指标' : '心跳新鲜；没有客户端 I/O 指标，覆盖未知');
      } catch (e) { signal.throwIfAborted(); this.status(`cluster:${cluster.id}`, 'unknown', e instanceof Error ? e.message : '指标查询失败', false); }
    }));
    const tasks = new Map<string, { run: TaskRun; watches: StorageWatch[] }>();
    let discoveryIncomplete = false;
    await Promise.all(watches.filter(w => w.kind !== 'cluster').map(async watch => {
      const previous = this.state.tasks[watch.id] ?? { scannedAt: 0, chains: {} };
      try {
        const runs = await this.provider.tasks(watch, Object.keys(previous.chains), previous.scannedAt || this.now() - 86400_000, signal);
        const chains: Record<string, Tracked> = {};
        for (const run of runs) {
          const old = previous.chains[run.chainId];
          if (old && BigInt(run.id) < BigInt(old.run.id)) throw new Error('平台返回的运行版本倒退，保留已有 Chain 记录');
          const inactive = run.status === 'finished';
          const seenAt = inactive && old?.run.id === run.id ? old.seenAt : this.now();
          if (inactive && this.now() - seenAt > 7 * 86400_000) continue;
          chains[run.chainId] = { run, dependencies: old?.dependencies ?? [], history: [...new Set([...(old?.history ?? []), run.id])].slice(-20), seenAt };
          const id = `${watch.platform}:${run.chainId}`;
          const found = tasks.get(id);
          if (found) { if (BigInt(run.id) > BigInt(found.run.id)) found.run = run; found.watches.push(watch); }
          else tasks.set(id, { run, watches: [watch] });
        }
        // Missing previously visible chains cannot be interpreted as success or disappearance.
        const returned = new Set(runs.map(r => r.chainId));
        const missing = Object.keys(previous.chains).filter(id => !returned.has(id));
        for (const id of missing) chains[id] = previous.chains[id]!;
        if (Object.keys(chains).length > this.config.maxTasks) throw new Error('已跟踪 Chain 超过 maxTasks');
        this.state.tasks[watch.id] = { scannedAt: this.now(), chains };
        if (missing.length) { discoveryIncomplete = true; this.status(`watch:${watch.id}`, 'unknown', '部分已跟踪 Chain 本轮不可见', false); }
        else this.status(`watch:${watch.id}`, runs.length ? 'pending' : 'idle', runs.length ? `已解析 ${runs.length} 条 Chain` : '当前没有发现任务');
      } catch (e) {
        signal.throwIfAborted(); discoveryIncomplete = true;
        this.status(`watch:${watch.id}`, 'unknown', e instanceof Error ? e.message : '平台查询失败', false);
      }
    }));
    const coverage = new Map<string, string[]>();
    const taskIo = new Map<string, { run: TaskRun; watches: string[]; io: IoSample[] }[]>();
    for (const [id, { run, watches: owners }] of tasks) {
      const observed: string[] = []; const missing: string[] = [];
      let failures = 0; let traffic = false;
      for (const cluster of this.config.clusters) {
        const sample = samples.get(cluster.id);
        const pods = new Set(run.pods);
        const io = sample?.io.filter(v => pods.has(v.pod) && this.fresh(v.at)) ?? [];
        if (io.length) {
          observed.push(cluster.id); failures += io.reduce((s, v) => s + v.failures, 0); traffic ||= io.some(v => v.chunks > 0);
          const list = taskIo.get(cluster.id) ?? [];
          list.push({ run, watches: owners.map(w => w.id), io }); taskIo.set(cluster.id, list);
        }
      }
      const knownDependencies = owners.flatMap(w => this.state.tasks[w.id]?.chains[run.chainId]?.dependencies ?? []);
      for (const cluster of new Set([...owners.flatMap(w => w.clusters), ...knownDependencies])) {
        if (!samples.has(cluster) || !observed.includes(cluster)) missing.push(cluster);
      }
      for (const owner of owners) {
        const tracked = this.state.tasks[owner.id]?.chains[run.chainId];
        if (tracked) tracked.dependencies = [...new Set([...(tracked.dependencies ?? []), ...observed])];
      }
      if (owners.some(w => !w.clusters.length)) missing.push('未声明完整依赖，目录外集群不可见');
      if (!run.pods.length) missing.push('运行尚无 pod 映射');
      coverage.set(id, missing);
      this.status(`task:${id}`, failures ? 'alert' : missing.length ? 'unknown' : traffic ? 'healthy' : 'idle',
        `run=${run.id}; 已观测集群=${observed.join(',') || '无'}${missing.length ? `; 未覆盖=${missing.join(',')}` : ''}; 平台状态=${run.status}`);
    }
    for (const cluster of this.config.clusters) {
      const key = hash([this.state.scope, cluster.id]);
      const old = this.state.incidents[key]; const sample = samples.get(cluster.id);
      if (!sample) { if (old) { old.healthySince = undefined; old.suspectSince = undefined; } continue; }
      const clusterWatch = watches.some(w => w.kind === 'cluster' && w.cluster === cluster.id);
      const observedTasks = taskIo.get(cluster.id) ?? [];
      if (!clusterWatch && !observedTasks.length && !old) continue;
      const io = clusterWatch ? sample.io.filter(v => this.fresh(v.at)) : observedTasks.flatMap(t => t.io);
      const uniqueIo = [...new Map(io.map(v => [v.pod, v])).values()];
      const failures = uniqueIo.reduce((s, v) => s + v.failures, 0);
      const lowNodes = clusterWatch && sample.connectedNodes < cluster.minConnectedNodes;
      const slow = this.config.latencyMs > 0 && uniqueIo.some(v => v.chunks > 0 && (v.latencyMs ?? 0) > this.config.latencyMs);
      const evidence: IncidentEvidence = { scope: this.state.scope, cluster: cluster.id, at: this.now(), sampleAt: uniqueIo.length ? Math.min(sample.at, Math.max(...uniqueIo.map(v => v.at))) : sample.at,
        failures, connectedNodes: sample.connectedNodes,
        reasons: [...(failures ? ['客户端 I/O 明确失败'] : []), ...(lowNodes ? ['连接节点数低于配置下限'] : []), ...(slow ? ['有负载的客户端延迟持续超阈值'] : [])],
        tasks: observedTasks.filter(t => t.io.some(v => v.failures > 0 || (v.chunks > 0 && (v.latencyMs ?? 0) > this.config.latencyMs && slow)))
          .map(t => ({ ...t.run, watches: t.watches })),
        coverage: [...new Set([...coverage.values()].flat()), ...(discoveryIncomplete ? ['平台任务发现不完整'] : [])],
      };
      const hasTraffic = uniqueIo.some(v => v.chunks > 0);
      const nodeOnly = old?.triggerReasons?.length === 1 && old.triggerReasons[0] === '连接节点数低于配置下限';
      const complete = !discoveryIncomplete && (hasTraffic || nodeOnly) && (clusterWatch || (observedTasks.length > 0 && evidence.coverage.length === 0));
      await this.assess(key, evidence, failures > 0 || lowNodes, slow, complete);
      if (this.state.incidents[key]?.open) this.status(`cluster:${cluster.id}`, 'alert', evidence.reasons.join('；') || '等待持续恢复确认');
    }
    for (const watch of watches) {
      if (watch.kind === 'cluster') {
        this.state.statuses[`watch:${watch.id}`] = { ...this.state.statuses[`cluster:${watch.cluster}`]! }; continue;
      }
      if (this.state.statuses[`watch:${watch.id}`]?.state === 'unknown') continue;
      const own = [...tasks].filter(([, t]) => t.watches.some(w => w.id === watch.id)).map(([id]) => this.state.statuses[`task:${id}`]!);
      const state = own.some(s => s.state === 'alert') ? 'alert' : own.some(s => s.state === 'unknown') ? 'unknown' : own.some(s => s.state === 'healthy') ? 'healthy' : 'idle';
      this.status(`watch:${watch.id}`, state, `UID ${watch.uid}；已解析 ${own.length} 条 Chain；详见任务覆盖`);
    }
    const activeStatusIds = new Set([...this.config.clusters.map(c => `cluster:${c.id}`), ...watches.map(w => `watch:${w.id}`), ...[...tasks.keys()].map(id => `task:${id}`)]);
    for (const id of Object.keys(this.state.statuses)) if (!activeStatusIds.has(id)) delete this.state.statuses[id];
    this.state.checkedAt = this.now(); this.error = undefined;
    await this.save(); await this.flush();
  }
  private async assess(key: string, evidence: IncidentEvidence, hard: boolean, slow: boolean, complete: boolean): Promise<void> {
    const incident = this.state.incidents[key] ??= { key, cluster: evidence.cluster, open: false, revision: 0,
      lastEmittedAt: 0, signature: '', sampleAt: 0 };
    incident.evidence = evidence;
    // Repeated reads of the same source timestamp cannot satisfy a sustained/recovery window.
    const advanced = evidence.sampleAt > incident.sampleAt;
    if (!advanced && !hard) return;
    if (incident.sampleAt && evidence.sampleAt - incident.sampleAt > this.config.staleSeconds * 1000) {
      incident.suspectSince = undefined; incident.healthySince = undefined;
    }
    incident.sampleAt = evidence.sampleAt;
    if (slow) incident.suspectSince ??= evidence.sampleAt; else incident.suspectSince = undefined;
    const bad = hard || (slow && evidence.sampleAt - incident.suspectSince! >= this.config.sustainSeconds * 1000);
    let resolve = false;
    if (hard || slow || !complete) incident.healthySince = undefined;
    else {
      incident.healthySince ??= evidence.sampleAt;
      resolve = incident.open && evidence.sampleAt - incident.healthySince >= this.config.recoverySeconds * 1000;
    }
    const signature = hash([evidence.reasons, evidence.tasks.map(t => [t.chainId, t.id]).sort()]);
    const changed = bad && (!incident.open || (signature !== incident.signature && !this.analysisBusy(key) && this.now() - incident.lastEmittedAt >= this.config.reanalyzeSeconds * 1000));
    if (!changed && !resolve) return;
    const wasOpen = incident.open;
    const next = { ...incident, open: !resolve, triggerReasons: evidence.reasons, revision: incident.revision + 1, lastEmittedAt: this.now(), signature };
    const folder = join(this.config.outputDir, key);
    await writeFileAtomic(join(folder, `${next.revision}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    next.event = { key, revision: next.revision, eventId: `${key}:${next.revision}`,
      operation: resolve ? 'resolve' : 'upsert', title: `3FS ${evidence.cluster}`, priority: 'high',
      reason: resolve ? '采集指标已连续恢复到配置范围内' : evidence.reasons.join('；'),
      url: '', time: this.now(), evidenceDir: folder, maxAttempts: 3, data: evidence,
      ...(!wasOpen || resolve ? { notice: resolve ? `3FS ${evidence.cluster}：监测指标已持续恢复。` :
        `3FS ${evidence.cluster}：${evidence.reasons.join('；')}。已排队启动分析；受影响的已订阅运行：${evidence.tasks.map(t => t.id).join(', ') || '尚无任务侧关联证据'}。` } : {}),
    };
    this.state.incidents[key] = next;
    await this.save();
  }
}
