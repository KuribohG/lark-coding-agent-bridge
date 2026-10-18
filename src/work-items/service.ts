import { createHash, randomUUID } from 'node:crypto';
import { log } from '../core/logger';
import { analysisFailureReason } from '../inbox/analysis-error';
import type { WorkItemConfig, WorkItemMode } from './config';
import { WorkItemStore } from './store';
import { handlingState, replyContent, resultText } from './result';
import type { Attention } from '../inbox/types';
import type { WorkItem } from './types';
import type { BatchAssessmentPolicy, SourceAdapter, WorkItemRuntime } from './contracts';
import type { AnalysisScheduler } from './scheduler';
import type { WorkItemEvent } from './events';
import { evidenceSignature as signature, observationDigest, recordObservation } from './identity';

const resolved = (job: WorkItem) => handlingState(job) !== 'open';
/** All state transitions are serialized. Model execution happens outside the lock. */
export class WorkItemService {
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private tasks: Partial<Record<'analysis' | 'triage', { controller: AbortController; done: Promise<void> }>> = {};
  private stopped = false;
  private closing?: Promise<void>;
  private modeChanges = 0;
  private polling?: Promise<void>;
  private refreshing?: Promise<void>;
  private notifying?: Promise<void>;
  private ticking?: Promise<void>;
  private dispatching?: Promise<void>;
  private dispatchRequested = false;
  private triageProgress = new Map<string, { signature: string; progress: NonNullable<Attention['progress']> }>();
  lastError?: string;
  constructor(readonly store: WorkItemStore, readonly config: WorkItemConfig, private io: WorkItemRuntime, private now = Date.now,
    private analysisQueue?: AnalysisScheduler) {
    this.source = io.source;
    const self = this;
    this.source.attach({ store, get closed() { return self.stopped; },
      get error() { return self.lastError; }, set error(value) { self.lastError = value; },
      observe: event => this.observe(event),
      transaction: fn => this.serial(fn), blocked: () => this.blocked(), assertEnabled: () => this.assertEnabled(),
      dispatch: () => this.dispatch(), touch: item => this.touch(item), ignore: item => this.ignore(item),
      abort: kind => { for (const [name, task] of Object.entries(this.tasks)) if (!kind || name === kind) task.controller.abort(); },
      clearAssessmentProgress: () => this.triageProgress.clear(),
      suspend: () => { this.modeChanges++; }, resume: () => { this.modeChanges--; },
    });
  }
  readonly source: SourceAdapter;
  private get batchPolicy() { return this.source.assessment?.kind === 'batch' ? this.source.assessment : undefined; }
  private safeSource(job: WorkItem): boolean { return this.source.safe(job); }
  private acceptsSource(job: WorkItem): boolean { return this.source.accepts(job); }
  private removeFeedback(): void { this.source.reconcile(); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p;
  }
  async start(): Promise<void> {
    if (this.config.enabled) await this.io.checkAccess();
    await this.store.load();
    const key = `${this.config.executorProfile}:${this.config.ownerOpenId}`;
    if (this.store.data.ownerKey && this.store.data.ownerKey !== key) throw new Error('待办归属已改变，请为新账号使用独立状态目录');
    this.store.data.ownerKey = key;
    this.removeFeedback();
    for (const job of this.store.data.jobs) {
      if (this.io.resumeInterrupted && job.restartPending && !resolved(job) && this.acceptsSource(job) &&
        job.businessState !== 'resolved' && job.external && job.external.analysisAttempts < job.external.maxAttempts && !job.draftEdited) {
        job.state = 'queued'; job.analysisRequested = true; job.analysisPaused = false; job.error = undefined;
      }
      job.restartPending = undefined;
      if (handlingState(job) === 'ignored' && (job.attention?.state !== 'quiet' || job.attention.retry || job.analysisRequested)) {
        this.ignore(job); this.touch(job);
      }
      if (!resolved(job) && job.attention?.state === 'uncertain' &&
        ['关注筛选未完成，请人工核对', '关注筛选结果缺失，请人工核对', '关注筛选暂不可用或今日额度已用完，请人工核对'].includes(job.attention.reason)) {
        job.attention = { state: 'pending', reason: '上次筛选未完成，等待自动重试', retry: { attempts: 0, nextAt: this.now(), error: '旧版筛选未完成' } };
        this.touch(job);
      }
    }
    this.source.initialize?.();
    await this.setMode(this.config.enabled ? 'on' : 'off');
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1000);
    this.timer.unref();
  }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const task of Object.values(this.tasks)) task.controller.abort();
    this.io.cancel?.();
    let sourceError: unknown;
    try { await this.source.close?.(); } catch (error) { sourceError = error; }
    await Promise.all(Object.values(this.tasks).map(task => task.done));
    await this.polling;
    await this.refreshing;
    await this.notifying;
    await this.ticking;
    await this.dispatching;
    await this.chain;
    if (sourceError) throw sourceError;
  }
  list(limit = 100): WorkItem[] {
    const jobs = structuredClone(this.store.data.jobs).reverse();
    for (const job of jobs) this.withProgress(job);
    return [...jobs.filter(j => !resolved(j) && j.attention?.state === 'needed'),
      ...jobs.filter(j => !resolved(j) && j.attention?.state !== 'needed' && j.attention?.state !== 'quiet'),
      ...jobs.filter(j => !resolved(j) && j.attention?.state === 'quiet'), ...jobs.filter(resolved)].slice(0, limit);
  }
  get(id: string): WorkItem | undefined {
    const job = this.store.data.jobs.find(j => j.id === id && j.ownerOpenId === this.config.ownerOpenId);
    return job ? this.withProgress(structuredClone(job)) : undefined;
  }
  private withProgress(job: WorkItem): WorkItem {
    const entry = this.triageProgress.get(job.id);
    if (entry && !this.blocked() && !resolved(job) && this.acceptsSource(job) && job.attention?.state === 'pending' && signature(job) === entry.signature) {
      job.attention.progress = { ...entry.progress };
    }
    return job;
  }
  async setMode(mode: WorkItemMode, persist?: () => Promise<void>): Promise<void> {
    if (!['off', 'on'].includes(mode)) throw new Error('无效运行模式');
    this.modeChanges++; this.source.invalidate();
    if (mode === 'off') { for (const task of Object.values(this.tasks)) task.controller.abort(); this.io.cancelPending?.(); this.triageProgress.clear(); }
    try {
      await this.serial(async () => {
        if (this.stopped) throw new Error('助理连接已关闭');
        await persist?.();
        const previous = this.config.enabled ? 'on' : 'off';
        this.config.enabled = mode === 'on'; this.config.autoAnalyze = false;
        this.source.modeChanged?.(previous, mode);
        await this.store.save();
      });
    } finally { this.modeChanges--; }
  }
  submitTask(event: WorkItemEvent): Promise<WorkItem> { return this.observe(event); }
  async observe(event: WorkItemEvent): Promise<WorkItem> {
    event = structuredClone(event);
    const source = this.source.acceptsEvents ? this.source.id : undefined;
    if (!source || !event.key || !event.title || !Number.isFinite(event.time) ||
      (event.revision !== undefined && (!Number.isSafeInteger(event.revision) || event.revision < 1 || !event.eventId)) ||
      (event.operation !== undefined && !['upsert', 'resolve'].includes(event.operation)) ||
      ((event.eventId !== undefined || event.operation !== undefined) && event.revision === undefined)) throw new Error('无效盯盘事项');
    return this.serial(async () => {
      if (this.stopped) throw new Error('事项来源已关闭');
      const id = createHash('sha256').update(JSON.stringify([source, this.config.ownerOpenId, this.config.executorProfile, event.key])).digest('hex');
      const existing = this.store.data.jobs.find(job => job.id === id);
      if (existing) return this.updateObservation(existing, event);
      const digest = observationDigest(event);
      const decision = this.source.assessment?.kind === 'rule' ? this.source.assessment.evaluate(event) : { state: 'needed' as const, reason: event.reason, priority: event.priority };
      const job: WorkItem = {
        id, ownerOpenId: this.config.ownerOpenId, profile: this.config.executorProfile,
        destination: { ...this.config.destination }, source: { chatId: '', name: event.title, type: 'external' },
        messages: [],
        createdAt: event.time, updatedAt: this.now(), state: decision.state === 'needed' ? 'queued' : 'waiting', automatic: true, alert: true,
        attention: decision, handlingState: 'open', revision: 1,
        ...event.initial,
        external: { source, key: event.key, url: event.url, data: structuredClone(event.data),
          analysisAttempts: 0, maxAttempts: Math.max(1, Math.min(3, event.maxAttempts ?? 3)), evidenceDir: event.evidenceDir },
      };
      this.enqueueNotice(job, event);
      recordObservation(job);
      if (event.revision !== undefined) job.observation = { id: event.eventId!, revision: event.revision, time: event.time, digest };
      if (event.operation === 'resolve') {
        job.businessState = 'resolved'; job.state = 'done';
        job.attention = { state: 'quiet', reason: event.reason };
      }
      job.analysisRequested = job.state === 'queued';
      this.store.data.jobs.push(job);
      try { await this.store.save(); } catch (error) { this.store.data.jobs.pop(); throw error; }
      return structuredClone(job);
    });
  }
  private async updateObservation(job: WorkItem, event: WorkItemEvent): Promise<WorkItem> {
    // Legacy submit is create-only. A collector must opt into ordered updates explicitly.
    if (event.revision === undefined || event.revision < (job.observation?.revision ?? 0)) return structuredClone(job);
    const digest = observationDigest(event);
    if (event.revision === job.observation?.revision) {
      if (job.observation.id !== event.eventId || job.observation.digest !== digest) throw new Error('事项观测版本冲突');
      return structuredClone(job);
    }
    if (job.observation?.id === event.eventId) throw new Error('观测 ID 不可复用于新版本');
    const decision = this.source.assessment?.kind === 'rule' ? this.source.assessment.evaluate(event) : { state: 'needed' as const, reason: event.reason, priority: event.priority };
    const before = structuredClone(job);
    const wasRunning = job.state === 'running';
    job.source.name = event.title;
    job.external!.data = structuredClone(event.data); job.external!.url = event.url;
    job.external!.evidenceDir = event.evidenceDir; job.external!.analysisAttempts = 0;
    recordObservation(job);
    job.origin!.url = event.url;
    job.observation = { id: event.eventId!, revision: event.revision, time: event.time, digest };
    job.businessState = event.operation === 'resolve' ? 'resolved' : 'open';
    job.draftStale = Boolean(job.result || job.replyDraft);
    job.analysisRequested = false;
    if (!resolved(job)) {
      job.attention = job.businessState === 'resolved' ? { state: 'quiet', reason: event.reason } : decision;
      if (job.businessState === 'open' && decision.state === 'needed' && !job.analysisPaused && !job.draftEdited) {
        job.state = 'queued'; job.automatic = true; job.analysisRequested = true;
        job.retryAt = undefined; job.error = undefined;
        job.resultDelivery = undefined; job.deliveredAt = undefined;
      } else if (['queued', 'running', 'ready', 'failed'].includes(job.state)) {
        job.state = job.result ? 'done' : 'waiting';
      }
    }
    this.enqueueNotice(job, event);
    this.touch(job);
    try { await this.store.save(); }
    catch (error) {
      for (const key of Object.keys(job)) delete (job as unknown as Record<string, unknown>)[key];
      Object.assign(job, before); throw error;
    }
    if (wasRunning) this.tasks.analysis?.controller.abort();
    return structuredClone(job);
  }
  async decide(id: string, action: string, owner: string): Promise<void> {
    if (owner !== this.config.ownerOpenId) throw new Error('forbidden');
    await this.serial(async () => {
      this.assertEnabled();
      const job = this.store.data.jobs.find(j => j.id === id);
      if (!job || job.ownerOpenId !== owner) throw new Error('unknown job');
      if (!['process', 'claim', 'ignore'].includes(action)) throw new Error('invalid action');
      if (resolved(job)) return;
      if (action === 'process') {
        if (!this.safeSource(job)) throw new Error('助理自身消息或结果群内容不可处理');
        if (job.state === 'running') return;
        job.restartPending = undefined; job.analysisPaused = false;
        if (job.state === 'queued') { job.automatic = false; job.analysisRequested = true; await this.store.save(); return; }
        job.state = 'queued'; job.automatic = false; job.analysisRequested = true;
        job.error = undefined; job.deliveredAt = undefined;
        job.startDelivery = undefined; job.resultDelivery = undefined;
        job.draftStale = Boolean(job.result || job.replyDraft);
        job.destination = { ...this.config.destination };
        job.retryAt = undefined;
        if (job.external) job.external.analysisAttempts = 0;
      } else {
        if (job.state === 'running') this.tasks.analysis?.controller.abort();
        job.state = action === 'claim' ? 'claimed' : 'ignored';
        job.handlingState = action === 'claim' ? 'handled' : 'ignored';
        if (action === 'ignore') this.ignore(job);
      }
      this.touch(job); await this.store.save();
    });
  }
  private touch(job: WorkItem): void { job.revision = (job.revision ?? 0) + 1; job.updatedAt = this.now(); }
  private ignore(job: WorkItem): void {
    job.state = 'ignored'; job.handlingState = 'ignored'; job.analysisRequested = false; job.dueAt = undefined;
    job.attention = { state: 'quiet', reason: '你已忽略此事项，无需动作' };
    if (this.triageProgress.delete(job.id) && !this.triageProgress.size) this.tasks.triage?.controller.abort();
  }
  async review(value: unknown, owner: string, requestId: string): Promise<WorkItem> {
    if (owner !== this.config.ownerOpenId) throw new Error('forbidden');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效草稿操作');
    const input = value as Record<string, unknown>;
    if (typeof input.id !== 'string' || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 ||
      (input.replyDraft === undefined && input.handlingState === undefined) ||
      (input.replyDraft !== undefined && (typeof input.replyDraft !== 'string' || input.replyDraft.length > 6000)) ||
      (input.handlingState !== undefined && !['open', 'handled', 'ignored'].includes(String(input.handlingState)))) throw new Error('无效草稿操作');
    return this.serial(async () => {
      if (this.stopped) throw new Error('助理连接已关闭');
      const job = this.store.data.jobs.find(j => j.id === input.id && j.ownerOpenId === owner);
      if (!job) throw new Error('待办不存在或已归档');
      if (job.lastReviewRequestId === requestId) return structuredClone(job);
      if ((job.revision ?? 0) !== input.revision) throw new Error('事项已更新，草稿未覆盖，请核对最新内容后重试');
      if (input.handlingState === 'open' && !this.safeSource(job)) throw new Error('助理自身消息或结果群内容不可恢复');
      const before = structuredClone(job);
      if (job.state === 'running') this.tasks.analysis?.controller.abort();
      if (['notifying', 'queued', 'running', 'ready'].includes(job.state)) job.state = 'waiting';
      job.restartPending = undefined;
      job.automatic = false; job.analysisRequested = false; job.analysisPaused = true; job.dueAt = undefined;
      if (input.replyDraft !== undefined) { job.replyDraft = input.replyDraft as string; job.draftEdited = true; job.draftStale = false; }
      if (input.handlingState !== undefined) job.handlingState = input.handlingState as WorkItem['handlingState'];
      if (input.handlingState === 'ignored') this.ignore(job);
      if (input.handlingState === 'open' && handlingState(before) === 'ignored') job.attention = job.external
        ? { state: 'needed', reason: '你已恢复此事项，可手动分析' } : { state: 'pending', reason: '你已恢复此事项，等待重新筛选' };
      if (input.handlingState === 'open' && ['claimed', 'ignored'].includes(job.state)) job.state = job.result ? 'done' : 'waiting';
      job.lastReviewRequestId = requestId; this.touch(job);
      try { await this.store.save(); }
      catch (error) {
        for (const key of Object.keys(job)) delete (job as unknown as Record<string, unknown>)[key];
        Object.assign(job, before); throw error;
      }
      return structuredClone(job);
    });
  }
  tick(): Promise<void> {
    // Collection, history refresh and dispatch each have at most one in-flight pass.
    return this.ticking ??= this.runTick().finally(() => { this.ticking = undefined; });
  }
  private async runTick(): Promise<void> {
    if (this.blocked()) return;
    if (!this.polling) this.polling = (this.source.poll?.() ?? Promise.resolve()).finally(() => { this.polling = undefined; });
    await this.polling;
    if (!this.notifying && this.io.notifyChange && !this.blocked()) this.notifying = this.notifyChanges()
      .catch(() => { this.pauseAfterFailure(); }).finally(() => { this.notifying = undefined; });
    await this.serial(async () => {
      if (this.blocked()) return;
      try {
        this.removeFeedback();
        const now = this.now();
        // The persisted topic is the only output target for an automatic run.
        for (const job of this.store.data.jobs) {
          if (job.state === 'ready' || (job.state === 'failed' && job.analysisTopic) || (this.io.notifyChange && job.state === 'done' && job.result && !job.deliveredAt && job.analysisTopic)) {
            if ((!this.io.notifyChange || job.businessState !== 'resolved') && !resolved(job) && this.safeSource(job) && (!job.draftStale || job.error) && (!job.automatic || this.acceptsSource(job)) && !job.deliveredAt &&
              (job.analysisTopic || (!this.config.gui.publicUrl && !job.automatic && job.attention?.state === 'needed'))) {
              const delivery = job.resultDelivery ??= { attempts: 0, startedAt: now, retryAt: now };
              if (delivery.attempts >= 3 || now - delivery.startedAt > 240_000) {
                job.error = '结果投递未确认，请在工作台查看；已停止重复发送';
                if (job.state === 'ready') job.state = 'done';
                continue;
              }
              if (delivery.retryAt > now) continue;
              delivery.attempts++; delivery.retryAt = now + 60_000; await this.store.save();
              try { await this.io.deliver(structuredClone(job), 'result'); job.deliveredAt = this.now(); }
              catch { this.lastError = '结果投递暂未确认，等待重试'; continue; }
            }
            if (job.state === 'ready') job.state = 'done';
          }
          if (job.state === 'notifying' || (job.state === 'queued' && !job.analysisRequested)) job.state = 'waiting';
        }
        await this.notifyAttention();
        // Keep durable state bounded; retain active jobs regardless of age.
        const quiet = new Set(this.store.data.jobs.filter(j => !resolved(j) && j.attention?.state === 'quiet').slice(-500).map(j => j.id));
        this.store.data.jobs = this.store.data.jobs.filter(j => resolved(j) ? now - j.updatedAt < 7 * 86400_000 : j.attention?.state !== 'quiet' || quiet.has(j.id));
        for (const [id, time] of Object.entries(this.store.data.seen)) if (now - time > 2 * 86400_000) delete this.store.data.seen[id];
        await this.store.save();
      } catch (e) { this.lastError = e instanceof Error ? e.message : 'inbox poll failed'; }
    });
    await this.dispatch();
    if (!this.refreshing && !this.blocked()) {
      this.refreshing = (this.source.refresh?.() ?? Promise.resolve()).finally(() => { this.refreshing = undefined; });
    }
  }
  private dispatch(): Promise<void> {
    this.dispatchRequested = true;
    return this.dispatching ??= this.runDispatch().catch(error => {
      this.pauseAfterFailure(); throw error;
    }).finally(() => {
      this.dispatching = undefined;
      // A completion can request dispatch between the loop exit and this cleanup.
      if (this.dispatchRequested && !this.blocked()) void this.dispatch().catch(() => {});
    });
  }
  private async runDispatch(): Promise<void> {
    do {
      this.dispatchRequested = false;
      await this.serial(() => this.dispatchJobs());
    } while (this.dispatchRequested && !this.blocked());
  }
  private async dispatchJobs(): Promise<void> {
    if (!this.tasks.analysis && !this.blocked()) {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const budgetAvailable = this.io.dailyAnalysisLimit === undefined || (this.store.data.autoUsage[day] ?? 0) < this.io.dailyAnalysisLimit;
      for (const job of this.store.data.jobs) if (job.state === 'queued' && job.automatic && !budgetAvailable) job.error = '今日自动分析额度已用完，告警保留，次日继续或手动处理';
      const next = this.store.data.jobs.find(j => (!j.automatic || budgetAvailable) && this.safeSource(j) && j.state === 'queued' && j.analysisRequested && !resolved(j) &&
        (!j.automatic || (j.attention?.state === 'needed' && this.acceptsSource(j))) &&
        (j.startDelivery?.confirmed || (j.startDelivery?.retryAt ?? 0) <= this.now()) && (j.retryAt ?? 0) <= this.now());
      if (next) {
        if (next.automatic && this.io.dailyAnalysisLimit !== undefined) this.store.data.autoUsage[day] = (this.store.data.autoUsage[day] ?? 0) + 1;
        next.state = 'running'; next.attempt = (next.attempt ?? 0) + 1; await this.store.save();
        if (this.blocked()) { next.state = 'waiting'; next.analysisRequested = false; await this.store.save(); return; }
        this.launch('analysis', signal => this.analysisQueue
          ? this.analysisQueue.run(signal, current => this.run(next, current)) : this.run(next, signal));
      }
    }
    if (!this.tasks.triage && !this.blocked()) {
      const candidates = this.batchPolicy?.select(this.store.data.jobs.filter(j => !resolved(j) && this.acceptsSource(j) && !j.analysisRequested &&
        !['queued', 'running'].includes(j.state) && j.attention?.state === 'pending' &&
        (j.attention.retry?.nextAt ?? 0) <= this.now())) ?? [];
      if (candidates.length) {
        const day = new Date(this.now()).toISOString().slice(0, 10);
        const usage = this.store.data.triageUsage ??= {};
        if (this.batchPolicy?.available === false || (usage[day] ?? 0) >= this.config.dailyTriageLimit) {
          for (const job of candidates) this.retryTriage(job, this.batchPolicy?.available === false ? '筛选服务暂不可用' : '今日筛选额度已用完',
            this.batchPolicy?.available === false ? this.now() + 900_000 : (Math.floor(this.now() / 86400_000) + 1) * 86400_000);
          await this.store.save();
        } else {
          usage[day] = (usage[day] ?? 0) + 1; await this.store.save();
          if (!this.blocked()) this.launch('triage', signal => this.triage(candidates, signal));
        }
      }
    }
  }
  private blocked(): boolean { return this.stopped || !this.config.enabled || this.modeChanges > 0; }
  private assertEnabled(): void { if (this.blocked()) throw new Error('助理已关闭或正在切换模式'); }
  private launch(kind: 'analysis' | 'triage', fn: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    const done = fn(controller.signal).catch(() => this.pauseAfterFailure()).finally(() => {
      delete this.tasks[kind];
      // Model completion must not wait for the next collection/history round.
      if (!this.blocked()) void this.dispatch().catch(() => {});
    });
    this.tasks[kind] = { controller, done };
  }
  private pauseAfterFailure(): void {
    this.lastError = '状态保存失败，助理已暂停'; this.stopped = true;
    for (const task of Object.values(this.tasks)) task.controller.abort();
  }
  private async triage(jobs: WorkItem[], signal: AbortSignal): Promise<void> {
    const inputs = structuredClone(jobs.filter(job => this.safeSource(job)));
    if (!inputs.length) return;
    const startedAt = this.now();
    const batchId = randomUUID();
    log.info('inbox', 'triage-started', { batchId, jobIds: inputs.map(job => job.id) });
    for (const job of inputs) this.triageProgress.set(job.id, { signature: signature(job), progress: { startedAt: this.now(), updatedAt: this.now(), text: '' } });
    try {
      let results: Awaited<ReturnType<BatchAssessmentPolicy['evaluate']>> = [];
      let failure: string | undefined;
      try { results = await this.batchPolicy!.evaluate(inputs, signal, updates => {
        if (signal.aborted || this.blocked()) return;
        for (const update of updates) {
          const entry = this.triageProgress.get(update.id);
          if (entry && entry.progress.text !== update.text) entry.progress = { ...entry.progress, text: update.text.slice(0, 240), updatedAt: this.now() };
        }
      }); }
      catch (error) { failure = this.batchPolicy?.failureReason?.(error) ?? '筛选未正常完成'; }
      await this.serial(async () => {
        if (signal.aborted || this.blocked()) return;
        for (const input of inputs) {
          const job = this.store.data.jobs.find(j => j.id === input.id);
          if (!job || resolved(job) || !this.acceptsSource(job) || signature(job) !== signature(input) || (job.revision ?? 0) !== (input.revision ?? 0) ||
            job.analysisRequested || ['queued', 'running'].includes(job.state) || job.attention?.state !== 'pending') continue;
          const result = results.find(r => r.id === job.id);
          if (failure || !result || result.state === 'pending') this.retryTriage(job, failure || (result ? result.reason || '必要的上下文查询未完成' : '关注筛选结果缺失'));
          else if (!this.batchPolicy!.valid(input, result)) this.retryTriage(job, '增量筛选未说明已有分析是否需要更新');
          else {
            this.batchPolicy!.apply(job, input, result);
            this.touch(job);
          }
        }
        await this.store.save();
      });
    } finally {
      for (const job of inputs) this.triageProgress.delete(job.id);
      log.info('inbox', 'triage-finished', { batchId, elapsedMs: this.now() - startedAt, aborted: signal.aborted });
    }
  }
  private retryTriage(job: WorkItem, error: string, nextAt?: number): void {
    const attempts = (job.attention?.retry?.attempts ?? 0) + 1;
    const delay = [30_000, 120_000, 300_000, 900_000][Math.min(attempts - 1, 3)]!;
    job.attention = { state: 'pending', reason: `${error}，将自动重试`, retry: { attempts, nextAt: nextAt ?? this.now() + delay, error } };
    this.touch(job);
  }
  private enqueueNotice(job: WorkItem, event: WorkItemEvent): void {
    if (!event.notice || !this.io.notifyChange) return;
    const notices = job.sourceNotices ??= [];
    // Keep only a small receipt history, never discard an outstanding delivery.
    job.sourceNotices = [...notices.filter(n => !n.sentAt && !n.abandoned),
      ...notices.filter(n => n.sentAt || n.abandoned).slice(-10),
      { id: event.eventId ?? randomUUID(), text: event.notice, startedAt: this.now(), attempts: 0, retryAt: this.now() }];
  }
  private async notifyChanges(): Promise<void> {
    if (!this.io.notifyChange || this.blocked()) return;
    for (const job of [...this.store.data.jobs]) {
      for (const notice of [...(job.sourceNotices ?? [])]) {
        const send = await this.serial(async () => {
          if (this.blocked() || resolved(job) || !this.acceptsSource(job) || job.notificationSuppressed || notice.sentAt || notice.abandoned) return false;
          if (notice.attempts >= 3 || this.now() - notice.startedAt > 240_000) {
            notice.abandoned = true; this.lastError = '来源通知未确认，请在工作台查看'; await this.store.save(); return false;
          }
          if (notice.retryAt > this.now()) return false;
          notice.attempts++; notice.retryAt = this.now() + 60_000; await this.store.save();
          return true;
        });
        if (!send) { if (!notice.sentAt && !notice.abandoned) break; continue; }
        let target: WorkItem['destination'];
        try { target = await this.io.notifyChange(structuredClone(job), structuredClone(notice)); }
        catch { this.lastError = '来源通知暂未确认，分析继续运行'; break; }
        await this.serial(async () => {
          // A send may finish after cancellation; retain its confirmed receipt and topic.
          job.analysisTopic = target; notice.sentAt = this.now();
          if (this.lastError === '来源通知暂未确认，分析继续运行') this.lastError = undefined;
          await this.store.save();
        });
      }
    }
  }
  private async notifyAttention(): Promise<void> {
    if (this.blocked() || !this.io.notifyAttention || this.io.beginAnalysis) return;
    const data = this.store.data; const now = this.now();
    const eligible = (j: WorkItem) => !resolved(j) && this.acceptsSource(j) && j.attention?.state === 'needed' && !j.notifiedAt && !j.notificationSuppressed;
    let outbox = data.notificationOutbox;
    if (!outbox) {
      const day = new Date(now).toISOString().slice(0, 10);
      const usage = data.notificationUsage ??= {};
      if ((data.lastDigestAt !== undefined && now - data.lastDigestAt < 600_000) || (usage[day] ?? 0) >= 12) return;
      const jobs = data.jobs.filter(eligible).slice(0, 20);
      if (!jobs.length) return;
      outbox = data.notificationOutbox = { id: randomUUID(), jobs: jobs.map(j => ({ id: j.id, signature: signature(j) })), attempts: 0, retryAt: now };
      data.lastDigestAt = now; usage[day] = (usage[day] ?? 0) + 1; await this.store.save();
    }
    if (outbox.retryAt > now) return;
    const jobs = outbox.jobs.map(entry => data.jobs.find(j => j.id === entry.id && signature(j) === entry.signature && eligible(j)));
    // Do not change an already-sent digest's content during retries.
    if (jobs.some(j => !j) || outbox.attempts >= 3 || now - (data.lastDigestAt ?? now) > 240_000) {
      if (outbox.attempts) for (const entry of outbox.jobs) { const j = data.jobs.find(j => j.id === entry.id); if (j) j.notificationSuppressed = true; }
      data.notificationOutbox = undefined; await this.store.save(); return;
    }
    outbox.attempts++; outbox.retryAt = now + 60_000; await this.store.save();
    await this.io.notifyAttention(jobs as WorkItem[], outbox.id);
    for (const job of jobs) job!.notifiedAt = this.now();
    data.notificationOutbox = undefined; await this.store.save();
  }
  async batchReview(value: unknown, owner: string, requestId?: string): Promise<void> {
    if (owner !== this.config.ownerOpenId) throw new Error('forbidden');
    const input = value as { items?: { id: string; revision: number }[]; handlingState?: string };
    if (!input || !Array.isArray(input.items) || !input.items.length || input.items.length > 500 ||
      !['handled', 'ignored'].includes(input.handlingState ?? '') || input.items.some(i => !i || typeof i.id !== 'string' || !Number.isSafeInteger(i.revision)) ||
      new Set(input.items.map(i => i.id)).size !== input.items.length) throw new Error('无效批量操作');
    await this.serial(async () => {
      if (this.stopped) throw new Error('助理连接已关闭');
      const jobs = input.items!.map(item => {
        const job = this.store.data.jobs.find(j => j.id === item.id && j.ownerOpenId === owner);
        if (!job || ((!requestId || job.lastReviewRequestId !== requestId) && (job.revision ?? 0) !== item.revision)) throw new Error('所选事项已更新，请刷新并重新选择；本次未修改任何事项');
        return job;
      });
      if (requestId && jobs.every(j => j.lastReviewRequestId === requestId)) return;
      const before = structuredClone(jobs);
      for (const job of jobs) {
        if (job.state === 'running') this.tasks.analysis?.controller.abort();
        job.handlingState = input.handlingState as 'handled' | 'ignored';
        job.state = input.handlingState === 'handled' ? 'claimed' : 'ignored';
        if (input.handlingState === 'ignored') this.ignore(job);
        job.analysisRequested = false; job.lastReviewRequestId = requestId; job.dueAt = undefined; this.touch(job);
      }
      try { await this.store.save(); }
      catch (error) { jobs.forEach((job, i) => { for (const key of Object.keys(job)) delete (job as unknown as Record<string, unknown>)[key]; Object.assign(job, before[i]); }); throw error; }
    });
  }
  private async run(job: WorkItem, signal: AbortSignal): Promise<void> {
    const attempt = job.attempt;
    const current = () => job.state === 'running' && job.attempt === attempt && !signal.aborted && !this.blocked();
    let announcing = false;
    try {
      signal.throwIfAborted();
      if (!this.safeSource(job)) throw new Error('助理自身消息或结果群内容不可处理');
      if (this.source.beforeAnalysis && !await this.source.beforeAnalysis(job, signal, current)) return;
      signal.throwIfAborted();
      if (!this.config.enabled || !job.analysisRequested) throw new Error('分析已取消或助理已关闭');
      if (this.io.beginAnalysis && !job.startDelivery?.confirmed) {
        announcing = true;
        await this.serial(async () => {
          if (!current()) throw new Error('分析已取消');
          const clean = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/<\/?at\b[^>]*>/gi, '');
          const page = this.config.gui.publicUrl || this.config.h5.publicUrl;
          const link = job.messages.find(m => m.link && /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(m.link))?.link;
          const delivery = job.startDelivery ??= { id: randomUUID(), attempts: 0, startedAt: this.now(), retryAt: this.now(),
            text: `已开始分析 · ${clean(job.source.name)}\n${clean(job.attention?.reason || '你提交的会话事项')}\n\n我会进行分析，并将结果和回复草稿发在本话题下。${link ? `\n原消息：${link}` : ''}${page ? `\n查看与处理：${page}#job=${job.id}` : ''}` };
          if (delivery.attempts >= 3 || this.now() - delivery.startedAt > 240_000) throw new Error('话题通知未确认，已停止重复创建；请在工作台核对');
          delivery.attempts++; delivery.retryAt = this.now() + 60_000;
          await this.store.save();
        });
        signal.throwIfAborted();
        const delivery = job.startDelivery!;
        const topic = await this.io.beginAnalysis(structuredClone(job), delivery.text);
        await this.serial(async () => {
          // Keep a confirmed topic even if the user cancels while the send is in flight.
          job.analysisTopic = topic;
          if (job.startDelivery?.id === delivery.id) job.startDelivery.confirmed = true;
          await this.store.save();
        });
        signal.throwIfAborted();
        if (!current()) throw new Error('分析已取消');
        announcing = false;
      }
      if (!this.safeSource(job)) throw new Error('事项来源不可处理');
      if (job.external) {
        await this.serial(async () => { job.external!.analysisAttempts++; await this.store.save(); });
        signal.throwIfAborted();
      }
      log.info('inbox', 'analysis-started', { jobId: job.id, attempt: job.attempt });
      const input = structuredClone(job);
      const result = await this.io.investigate(input, signal);
      await this.serial(async () => {
        job.inputTokens = result.inputTokens; job.outputTokens = result.outputTokens;
        if (current()) {
          const fields = replyContent(result.text);
          job.result = resultText(result.text); job.analysis = fields.analysis; job.missingInfo = fields.missingInfo;
          job.analyzedVersion = input.evidenceVersion;
          if (result.businessState) job.businessState = result.businessState;
          if (!job.draftEdited) { job.replyDraft = fields.replyDraft; job.draftStale = false; }
          job.state = 'ready'; job.analysisRequested = false; job.error = undefined;
          this.source.afterAnalysis?.(job, input);
          this.touch(job);
        }
        else if (job.state === 'running') { job.state = 'failed'; job.analysisRequested = false; job.analysisPaused = true; job.error = '分析已取消'; }
        job.updatedAt = this.now(); await this.store.save();
      });
    } catch (e) {
      log.warn('inbox', 'analysis-failed', { jobId: job.id, announcing, error: e instanceof Error ? e.message : String(e) });
      await this.serial(async () => {
        if (job.state === 'running') {
          const delivery = job.startDelivery;
          if (announcing && !signal.aborted && !this.blocked() && delivery && delivery.attempts < 3 && this.now() - delivery.startedAt <= 180_000) {
            job.state = 'queued'; job.error = '分析通知暂未确认，等待重试';
          } else if (job.external && job.automatic && !announcing && !signal.aborted && !this.blocked() &&
            job.external.analysisAttempts < job.external.maxAttempts) {
            job.state = 'queued'; job.retryAt = this.now() + 60_000 * 2 ** Math.max(0, job.external.analysisAttempts - 1);
            job.error = `${analysisFailureReason(e)}，等待自动重试`;
          } else {
            job.state = 'failed'; job.analysisRequested = false; job.analysisPaused = true;
            if (this.stopped && this.io.resumeInterrupted) job.restartPending = true;
            job.error = signal.aborted ? '分析已取消' : announcing ? '话题通知未确认，尚未启动分析；请在工作台核对' : analysisFailureReason(e);
          }
        }
        job.updatedAt = this.now(); await this.store.save();
      });
    }
  }
}
