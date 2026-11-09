import { log } from '../core/logger';
import { analysisFailureReason } from './analysis-error';
import type { WorkItemConfig } from './config';
import type { WorkItemCore } from './control';
import { analysisFields, resolved, resultText } from './result';
import type { WorkItemTasks } from './tasks';
import type { WorkItem } from './types';

/** Picks queued items within the daily budget and runs their investigation to a result or retry. */
export class WorkItemAnalysis {
  constructor(private core: WorkItemCore<WorkItemConfig>, private tasks: WorkItemTasks) {}
  async dispatchNext(): Promise<boolean> {
    const { store, control, io, now, source } = this.core;
    if (control.blocked() || io.canInvestigate?.() === false) return false;
    const day = new Date(now()).toISOString().slice(0, 10);
    const budgetAvailable = io.dailyAnalysisLimit === undefined || (store.data.autoUsage[day] ?? 0) < io.dailyAnalysisLimit;
    for (const job of store.data.jobs) if (job.state === 'queued' && job.automatic && !budgetAvailable) job.error = '今日自动分析额度已用完，告警保留，次日继续或手动处理';
    const next = store.data.jobs.find(j => !this.tasks.analyses.has(j.id) && (!j.automatic || budgetAvailable) && source.safe(j) && j.state === 'queued' && j.analysisRequested && !resolved(j) &&
      (!j.automatic || (j.attention?.state === 'needed' && source.accepts(j))) &&
      (j.startDelivery?.confirmed || (j.startDelivery?.retryAt ?? 0) <= now()) && (j.retryAt ?? 0) <= now());
    if (!next) return false;
    const budgetDay = next.automatic && io.dailyAnalysisLimit !== undefined ? day : undefined;
    if (budgetDay) store.data.autoUsage[budgetDay] = (store.data.autoUsage[budgetDay] ?? 0) + 1;
    next.state = 'running'; next.attempt = (next.attempt ?? 0) + 1; await store.save();
    if (control.blocked()) { next.state = 'waiting'; next.analysisRequested = false; await store.save(); return false; }
    this.tasks.start('analysis', next.id, signal => this.run(next, signal, budgetDay));
    return true;
  }
  private async waitForExecutor(job: WorkItem, current: () => boolean, budgetDay?: string): Promise<boolean> {
    const { store, control, io } = this.core;
    if (io.canInvestigate?.() !== false) return false;
    await control.serial(async () => {
      if (!current()) throw new Error('分析已取消');
      job.state = 'queued';
      if (budgetDay) store.data.autoUsage[budgetDay] = Math.max(0, (store.data.autoUsage[budgetDay] ?? 0) - 1);
      await store.save();
    });
    return true;
  }
  private async run(job: WorkItem, signal: AbortSignal, budgetDay?: string): Promise<void> {
    const { store, config, control, io, now, source, lifecycle, delivery } = this.core;
    const attempt = job.attempt;
    const current = () => job.state === 'running' && job.attempt === attempt && !signal.aborted && !control.blocked();
    let announcing = false;
    try {
      signal.throwIfAborted();
      if (await this.waitForExecutor(job, current, budgetDay)) return;
      if (!source.safe(job)) throw new Error('助理自身消息或结果群内容不可处理');
      if (source.beforeAnalysis && !await source.beforeAnalysis(job, signal, current)) return;
      signal.throwIfAborted();
      if (!config.enabled || !job.analysisRequested) throw new Error('分析已取消或助理已关闭');
      if (io.beginAnalysis && !job.startDelivery?.confirmed) {
        announcing = true;
        await delivery.begin(job, signal, current);
        signal.throwIfAborted();
        if (!current()) throw new Error('分析已取消');
        announcing = false;
      }
      if (!source.safe(job)) throw new Error('事项来源不可处理');
      if (await this.waitForExecutor(job, current, budgetDay)) return;
      if (job.external) {
        await control.serial(async () => { job.external!.analysisAttempts++; await store.save(); });
        signal.throwIfAborted();
      }
      log.info('inbox', 'analysis-started', { jobId: job.id, attempt: job.attempt });
      const input = structuredClone(job);
      const result = await io.investigate(input, signal);
      await control.serial(async () => {
        job.inputTokens = result.inputTokens; job.outputTokens = result.outputTokens;
        if (current()) {
          const fields = analysisFields(result.text);
          job.result = resultText(fields); job.analysis = fields.analysis; job.missingInfo = fields.missingInfo;
          job.analyzedVersion = input.evidenceVersion;
          if (result.businessState) job.businessState = result.businessState;
          if (!job.draftEdited) { job.replyDraft = fields.replyDraft; job.draftStale = false; }
          job.state = 'ready'; job.analysisRequested = false; job.error = undefined;
          const context = source.analysisContext?.(job, input);
          if (context) lifecycle.completeContext(job, context);
          lifecycle.touch(job);
        }
        else if (job.state === 'running') { job.state = 'failed'; job.analysisRequested = false; job.analysisPaused = true; job.error = '分析已取消'; }
        job.updatedAt = now(); await store.save();
      });
    } catch (e) {
      log.warn('inbox', 'analysis-failed', { jobId: job.id, announcing, error: e instanceof Error ? e.message : String(e) });
      await control.serial(async () => {
        if (job.state === 'running') {
          const startDelivery = job.startDelivery;
          if (announcing && !signal.aborted && !control.blocked() && startDelivery && startDelivery.attempts < 3 && now() - startDelivery.startedAt <= 180_000) {
            job.state = 'queued'; job.error = '分析通知暂未确认，等待重试';
          } else if (job.external && job.automatic && !announcing && !signal.aborted && !control.blocked() &&
            job.external.analysisAttempts < job.external.maxAttempts) {
            job.state = 'queued'; job.retryAt = now() + 60_000 * 2 ** Math.max(0, job.external.analysisAttempts - 1);
            job.error = `${analysisFailureReason(e)}，等待自动重试`;
          } else {
            job.state = 'failed'; job.analysisRequested = false; job.analysisPaused = true;
            if (control.stopped && io.resumeInterrupted) job.restartPending = true;
            job.error = signal.aborted ? '分析已取消' : announcing ? '话题通知未确认，尚未启动分析；请在工作台核对' : analysisFailureReason(e);
          }
        }
        job.updatedAt = now(); await store.save();
      });
    }
  }
}
