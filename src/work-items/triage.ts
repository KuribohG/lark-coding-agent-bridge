import { log } from '../core/logger';
import type { WorkItemConfig } from './config';
import type { ItemAssessmentPolicy, SourceAdapter } from './contracts';
import type { WorkItemCore } from './control';
import type { Attention } from './evidence';
import { evidenceSignature as signature } from './identity';
import { resolved } from './result';
import type { WorkItemTasks } from './tasks';
import type { WorkItem } from './types';

export const itemPolicy = (source: SourceAdapter) => source.assessment?.kind === 'item' ? source.assessment : undefined;

/** Attention screening of individual items by the source's item policy, with live progress. */
export class WorkItemTriage {
  private progress = new Map<string, { signature: string; progress: NonNullable<Attention['progress']> }>();
  constructor(private core: WorkItemCore<WorkItemConfig>, private tasks: WorkItemTasks) {}
  private get itemPolicy() { return itemPolicy(this.core.source); }
  clearProgress(): void { this.progress.clear(); }
  forget(id: string): void { this.progress.delete(id); }
  withProgress(job: WorkItem): WorkItem {
    const entry = this.progress.get(job.id);
    if (entry && !this.core.control.blocked() && !resolved(job) && this.core.source.accepts(job) && job.attention?.state === 'pending' && signature(job) === entry.signature) {
      job.attention.progress = { ...entry.progress };
    }
    return job;
  }
  async dispatchNext(): Promise<boolean> {
    const { store, control, config, now } = this.core;
    if (control.blocked() || !this.itemPolicy) return false;
    const job = store.data.jobs.find(j => !this.tasks.screenings.has(j.id) && !resolved(j) && this.core.source.safe(j) && this.core.source.accepts(j) && !j.analysisRequested &&
      !['queued', 'running'].includes(j.state) && j.attention?.state === 'pending' && (j.attention.retry?.nextAt ?? 0) <= now());
    if (!job) return false;
    const day = new Date(now()).toISOString().slice(0, 10);
    const usage = store.data.triageUsage ??= {};
    if (this.itemPolicy.available === false || (usage[day] ?? 0) >= config.dailyTriageLimit) {
      this.retry(job, this.itemPolicy.available === false ? '筛选服务暂不可用' : '今日筛选额度已用完',
        this.itemPolicy.available === false ? now() + 900_000 : (Math.floor(now() / 86400_000) + 1) * 86400_000);
      await store.save();
    } else {
      usage[day] = (usage[day] ?? 0) + 1; await store.save();
      if (!control.blocked()) this.tasks.start('triage', job.id, signal => this.triage(job, signal));
    }
    return true;
  }
  private async triage(job: WorkItem, signal: AbortSignal): Promise<void> {
    const { store, control, now, lifecycle } = this.core;
    if (signal.aborted || control.blocked() || !this.core.source.safe(job) || resolved(job) || job.analysisRequested ||
      ['queued', 'running'].includes(job.state) || job.attention?.state !== 'pending') return;
    const input = structuredClone(job);
    const startedAt = now();
    log.info('inbox', 'triage-started', { jobId: input.id });
    this.progress.set(input.id, { signature: signature(input), progress: { startedAt, updatedAt: startedAt, text: '' } });
    try {
      let result: Awaited<ReturnType<ItemAssessmentPolicy['evaluate']>> | undefined;
      let failure: string | undefined;
      try { result = await this.itemPolicy!.evaluate(input, signal, text => {
        if (signal.aborted || control.blocked()) return;
        const entry = this.progress.get(input.id);
        if (entry && entry.progress.text !== text) entry.progress = { ...entry.progress, text: text.slice(0, 240), updatedAt: now() };
      }); }
      catch (error) { failure = this.itemPolicy?.failureReason?.(error) ?? '筛选未正常完成'; }
      await control.serial(async () => {
        if (signal.aborted || control.blocked()) return;
        const current = store.data.jobs.find(j => j.id === input.id);
        if (!current || resolved(current) || !this.core.source.accepts(current) || signature(current) !== signature(input) || (current.revision ?? 0) !== (input.revision ?? 0) ||
          current.analysisRequested || ['queued', 'running'].includes(current.state) || current.attention?.state !== 'pending') return;
        if (failure || !result || result.id !== input.id || result.state === 'pending') this.retry(current, failure || (result?.id === input.id ? result.reason || '必要的上下文查询未完成' : '关注筛选结果缺失或事项不匹配'));
        else if (!this.itemPolicy!.valid(input, result)) this.retry(current, '增量筛选未说明已有分析是否需要更新');
        else {
          lifecycle.assess(current, this.itemPolicy!.interpret(input, result));
          lifecycle.touch(current);
        }
        await store.save();
      });
    } finally {
      this.progress.delete(input.id);
      log.info('inbox', 'triage-finished', { jobId: input.id, elapsedMs: now() - startedAt, aborted: signal.aborted });
    }
  }
  private retry(job: WorkItem, error: string, nextAt?: number): void {
    const attempts = (job.attention?.retry?.attempts ?? 0) + 1;
    const delay = [30_000, 120_000, 300_000, 900_000][Math.min(attempts - 1, 3)]!;
    job.attention = { state: 'pending', reason: `${error}，将自动重试`, retry: { attempts, nextAt: nextAt ?? this.core.now() + delay, error } };
    this.core.lifecycle.touch(job);
  }
}
