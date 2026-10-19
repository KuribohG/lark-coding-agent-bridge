import type { WorkItemConfig } from './config';
import type { WorkItem } from './types';
import type { Attention } from '../inbox/types';
import { handlingState } from './result';
import { recordObservation } from './identity';

/** Sources may update evidence; lifecycle fields are read-only through their context. */
type EvidenceFields = 'messages' | 'source' | 'alert' | 'intakeTrigger' | 'incidentId' | 'manualSignature' | 'manualRequestIds';
export type SourceItem = Readonly<Omit<WorkItem, EvidenceFields>> & Pick<WorkItem, EvidenceFields>;
export type SourceSeed = Pick<WorkItem, 'source' | 'messages' | 'alert' | 'intakeTrigger' | 'incidentId'>;
export type SourceTransition =
  | { type: 'mode'; mode: 'on' | 'off' }
  | { type: 'scope' }
  | { type: 'feedback'; empty: boolean; reason: string }
  | { type: 'manual'; replay?: boolean }
  | { type: 'handled' }
  | { type: 'recovered' }
  | { type: 'evidence'; preflight?: boolean };
export interface AssessmentUpdate {
  attention: Attention;
  followUp?: 'unchanged' | 'resolved' | 'reanalyze';
  basis?: NonNullable<WorkItem['analysisBasis']>['messages'];
  autoAnalyze: boolean;
}
export interface AnalysisContext {
  basis: NonNullable<WorkItem['analysisBasis']>;
  changed: boolean;
}

/** Called only in the engine's serialized transaction. Sources supply facts, not state patches. */
export class WorkItemLifecycle {
  constructor(private config: WorkItemConfig, private now: () => number, private cancel: (job: WorkItem) => void,
    private clearAssessment: (job: WorkItem) => void) {}
  touch(job: WorkItem): void { job.revision = (job.revision ?? 0) + 1; job.updatedAt = this.now(); }
  ignore(job: WorkItem): void {
    this.cancel(job);
    job.state = 'ignored'; job.handlingState = 'ignored'; job.analysisRequested = false; job.dueAt = undefined;
    job.attention = { state: 'quiet', reason: '你已忽略此事项，无需动作' };
    this.clearAssessment(job);
  }
  handle(job: WorkItem): void {
    this.cancel(job);
    job.state = 'claimed'; job.handlingState = 'handled'; job.analysisRequested = false; job.dueAt = undefined;
  }
  pause(job: WorkItem): void {
    this.cancel(job);
    if (['notifying', 'queued', 'running', 'ready'].includes(job.state)) job.state = 'waiting';
    job.restartPending = undefined;
    job.automatic = false; job.analysisRequested = false; job.analysisPaused = true; job.dueAt = undefined;
  }
  request(job: WorkItem): void {
    if (handlingState(job) !== 'open' || job.state === 'running') return;
    job.restartPending = undefined; job.analysisPaused = false;
    if (job.state === 'queued') { job.automatic = false; job.analysisRequested = true; return; }
    job.state = 'queued'; job.automatic = false; job.analysisRequested = true;
    job.error = undefined; job.deliveredAt = undefined;
    job.startDelivery = undefined; job.resultDelivery = undefined;
    job.draftStale = Boolean(job.result || job.replyDraft);
    job.destination = { ...this.config.destination }; job.retryAt = undefined;
    if (job.external) job.external.analysisAttempts = 0;
  }
  transition(job: WorkItem, event: SourceTransition): void {
    switch (event.type) {
      case 'mode':
        job.dueAt = undefined;
        job.attention ??= { state: 'pending', reason: '等待关注筛选' };
        if (job.state === 'notifying' || (['queued', 'running'].includes(job.state) && (event.mode === 'off' || !job.analysisRequested))) {
          job.state = 'waiting'; job.analysisRequested = false;
        }
        if (event.mode === 'off') { job.analysisRequested = false; job.analysisPaused = true; }
        return;
      case 'scope':
        this.pause(job);
        job.error = '接收范围已更新，已有事项可手动处理';
        break;
      case 'feedback':
        this.cancel(job);
        job.analysisRequested = false; job.startDelivery = undefined; job.resultDelivery = undefined;
        job.retryAt = undefined; job.dueAt = undefined; job.notificationSuppressed = true;
        job.draftStale = Boolean(job.result || job.replyDraft); job.error = undefined;
        if (event.empty) { this.ignore(job); job.attention = { state: 'quiet', reason: event.reason }; }
        else {
          recordObservation(job);
          if (handlingState(job) === 'open') {
            job.state = 'waiting'; job.attention = { state: 'pending', reason: '已排除助理自身消息，重新筛选' };
            job.notificationSuppressed = false; job.notifiedAt = undefined;
          }
        }
        break;
      case 'manual':
        if (event.replay) { if (job.state === 'queued') job.automatic = false; return; }
        if (handlingState(job) !== 'open' || job.state === 'running') return;
        recordObservation(job);
        this.request(job);
        job.destination = { ...this.config.destination };
        job.notificationSuppressed = true; job.startDelivery = undefined; job.resultDelivery = undefined; job.deliveredAt = undefined;
        job.attention = { state: 'needed', reason: '你主动选择了此会话' };
        job.draftStale = Boolean(job.result || job.replyDraft);
        break;
      case 'handled': this.handle(job); break;
      case 'recovered': job.businessState = 'resolved'; this.ignore(job); break;
      case 'evidence': {
        recordObservation(job);
        if (event.preflight) break;
        job.draftStale = Boolean(job.result || job.replyDraft);
        // Incremental sources retain a running analysis's input snapshot.
        if (job.state === 'running' || handlingState(job) !== 'open') break;
        const retry = job.attention?.retry;
        job.attention = { state: 'pending', reason: retry ? job.attention!.reason : '新消息等待筛选', ...(retry ? { retry } : {}) };
        job.analysisRequested = false;
        if (['queued', 'ready', 'done', 'failed'].includes(job.state)) {
          job.state = 'waiting'; job.automatic = false; job.dueAt = undefined;
        }
        break;
      }
    }
    this.touch(job);
  }
  assess(job: WorkItem, update: AssessmentUpdate): void {
    if (handlingState(job) !== 'open') return;
    if (update.followUp === 'unchanged') {
      job.attention = job.analysisBasis?.attention ?? { state: 'needed', reason: '已有分析仍适用' };
      if (update.basis) job.analysisBasis = { messages: update.basis, attention: { ...job.attention } };
      job.analyzedVersion = job.evidenceVersion;
      job.draftStale = job.attention.state === 'quiet'; job.error = undefined;
      job.state = job.draftStale || job.deliveredAt || job.analysisPaused || job.draftEdited ? 'done' : 'ready';
      return;
    }
    job.attention = update.attention;
    if (update.followUp === 'resolved') {
      job.businessState = 'resolved';
      if (update.basis) job.analysisBasis = { messages: update.basis, attention: { ...job.attention } };
      job.state = 'done'; job.draftStale = true; job.error = undefined;
    }
    if (job.attention.state === 'needed') job.businessState = 'open';
    if (job.attention.state === 'needed' && update.autoAnalyze && !job.draftEdited && !job.analysisPaused) {
      job.state = 'queued'; job.automatic = true; job.analysisRequested = true;
      job.destination = { ...this.config.destination };
      job.resultDelivery = undefined; job.deliveredAt = undefined; job.error = undefined;
    }
  }
  completeContext(job: WorkItem, context: AnalysisContext): void {
    job.analysisBasis = context.basis; job.attention = { ...context.basis.attention };
    if (context.changed) {
      job.state = 'waiting'; job.draftStale = true;
      job.attention = { state: 'pending', reason: '分析已完成，等待核对期间收到的新消息' };
    }
  }
}
