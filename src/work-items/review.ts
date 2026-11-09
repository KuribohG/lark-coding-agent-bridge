import type { WorkItemConfig } from './config';
import type { WorkItemCore } from './control';
import { handlingState, resolved } from './result';
import type { WorkItemTasks } from './tasks';
import { itemPolicy } from './triage';
import type { WorkItem } from './types';

function restore(job: WorkItem, before: WorkItem): void {
  for (const key of Object.keys(job)) delete (job as unknown as Record<string, unknown>)[key];
  Object.assign(job, before);
}

/** Owner actions on items; each is validated, applied and persisted in one transition. */
export class WorkItemReview {
  constructor(private core: WorkItemCore<WorkItemConfig>, private tasks: WorkItemTasks) {}
  private get ownerKey(): string { return this.core.config.ownerKey; }
  async decide(id: string, action: string, owner: string): Promise<void> {
    if (owner !== this.ownerKey) throw new Error('forbidden');
    const { store, control, lifecycle, source } = this.core;
    await control.serial(async () => {
      control.assertEnabled();
      const job = store.data.jobs.find(j => j.id === id);
      if (!job || job.ownerKey !== owner) throw new Error('unknown job');
      if (!['process', 'claim', 'ignore'].includes(action)) throw new Error('invalid action');
      if (resolved(job)) return;
      if (action === 'process') {
        if (!source.safe(job)) throw new Error('助理自身消息或结果群内容不可处理');
        if (job.state === 'running') return;
        lifecycle.request(job);
      } else if (action === 'claim') lifecycle.handle(job);
      else lifecycle.ignore(job);
      lifecycle.touch(job); await store.save();
    });
  }
  async stopAnalysis(value: unknown, owner: string, requestId?: string): Promise<WorkItem> {
    if (owner !== this.ownerKey) throw new Error('forbidden');
    const input = value as { id?: string; revision?: number } | null;
    if (!input || typeof input.id !== 'string' || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new Error('无效停止操作');
    const { store, control, lifecycle, now } = this.core;
    return control.serial(async () => {
      if (control.stopped) throw new Error('助理连接已关闭');
      const job = store.data.jobs.find(j => j.id === input.id && j.ownerKey === owner);
      if (!job) throw new Error('待办不存在或已归档');
      if (requestId && job.lastStopRequestId === requestId) return structuredClone(job);
      if ((job.revision ?? 0) !== input.revision) throw new Error('事项已更新，请刷新后重新停止分析');
      if (resolved(job) || !['queued', 'running'].includes(job.state)) throw new Error('此事项没有正在进行或排队的分析');
      const before = structuredClone(job);
      const controller = job.state === 'running' ? this.tasks.analyses.get(job.id)?.controller : undefined;
      job.state = 'waiting'; job.automatic = false; job.analysisRequested = false;
      job.analysisPaused = true; job.restartPending = undefined;
      job.analysisStoppedAt = now(); job.lastStopRequestId = requestId;
      job.startDelivery = undefined; job.resultDelivery = undefined; job.retryAt = undefined; job.dueAt = undefined; job.error = undefined;
      lifecycle.touch(job);
      try { await store.save(); }
      catch (error) { restore(job, before); throw error; }
      // Persist the cancellation before aborting; late output cannot revive this item.
      controller?.abort();
      return structuredClone(job);
    });
  }
  async review(value: unknown, owner: string, requestId: string): Promise<WorkItem> {
    if (owner !== this.ownerKey) throw new Error('forbidden');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效草稿操作');
    const input = value as Record<string, unknown>;
    if (typeof input.id !== 'string' || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 ||
      (input.replyDraft === undefined && input.handlingState === undefined) ||
      (input.replyDraft !== undefined && (typeof input.replyDraft !== 'string' || input.replyDraft.length > 6000)) ||
      (input.handlingState !== undefined && !['open', 'handled', 'ignored'].includes(String(input.handlingState)))) throw new Error('无效草稿操作');
    const { store, control, lifecycle, source } = this.core;
    return control.serial(async () => {
      if (control.stopped) throw new Error('助理连接已关闭');
      const job = store.data.jobs.find(j => j.id === input.id && j.ownerKey === owner);
      if (!job) throw new Error('待办不存在或已归档');
      if (job.lastReviewRequestId === requestId) return structuredClone(job);
      if ((job.revision ?? 0) !== input.revision) throw new Error('事项已更新，草稿未覆盖，请核对最新内容后重试');
      if (input.handlingState === 'open' && !source.safe(job)) throw new Error('助理自身消息或结果群内容不可恢复');
      const before = structuredClone(job);
      lifecycle.pause(job);
      if (input.replyDraft !== undefined) { job.replyDraft = input.replyDraft as string; job.draftEdited = true; job.draftStale = false; }
      if (input.handlingState !== undefined) job.handlingState = input.handlingState as WorkItem['handlingState'];
      if (input.handlingState === 'ignored') lifecycle.ignore(job);
      // A source that screens items screens a restored one again; a rule source has nothing to re-decide.
      if (input.handlingState === 'open' && handlingState(before) === 'ignored') job.attention = itemPolicy(source)
        ? { state: 'pending', reason: '你已恢复此事项，等待重新筛选' } : { state: 'needed', reason: '你已恢复此事项，可手动分析' };
      if (input.handlingState === 'open' && ['claimed', 'ignored'].includes(job.state)) job.state = job.result ? 'done' : 'waiting';
      job.lastReviewRequestId = requestId; lifecycle.touch(job);
      try { await store.save(); }
      catch (error) { restore(job, before); throw error; }
      return structuredClone(job);
    });
  }
  async batchReview(value: unknown, owner: string, requestId?: string): Promise<void> {
    if (owner !== this.ownerKey) throw new Error('forbidden');
    const input = value as { items?: { id: string; revision: number }[]; handlingState?: string };
    if (!input || !Array.isArray(input.items) || !input.items.length || input.items.length > 500 ||
      !['handled', 'ignored'].includes(input.handlingState ?? '') || input.items.some(i => !i || typeof i.id !== 'string' || !Number.isSafeInteger(i.revision)) ||
      new Set(input.items.map(i => i.id)).size !== input.items.length) throw new Error('无效批量操作');
    const { store, control, lifecycle } = this.core;
    await control.serial(async () => {
      if (control.stopped) throw new Error('助理连接已关闭');
      const jobs = input.items!.map(item => {
        const job = store.data.jobs.find(j => j.id === item.id && j.ownerKey === owner);
        if (!job || ((!requestId || job.lastReviewRequestId !== requestId) && (job.revision ?? 0) !== item.revision)) throw new Error('所选事项已更新，请刷新并重新选择；本次未修改任何事项');
        return job;
      });
      if (requestId && jobs.every(j => j.lastReviewRequestId === requestId)) return;
      const before = structuredClone(jobs);
      for (const job of jobs) {
        if (input.handlingState === 'handled') lifecycle.handle(job);
        else lifecycle.ignore(job);
        job.lastReviewRequestId = requestId; lifecycle.touch(job);
      }
      try { await store.save(); }
      catch (error) { jobs.forEach((job, i) => restore(job, before[i]!)); throw error; }
    });
  }
}
