import { randomUUID } from 'node:crypto';
import { WorkItemLifecycle } from './lifecycle';
import { WorkItemDelivery } from './delivery';
import type { WorkItemConfig, WorkItemMode } from './config';
import type { WorkItemStore } from './store';
import { handlingState, resolved } from './result';
import type { WorkItem } from './types';
import type { SourceAdapter, WorkItemRuntime } from './contracts';
import { WorkItemScheduler } from './scheduler';
import { WORK_ITEM_CONCURRENCY_DEFAULTS } from './concurrency';
import type { WorkItemEvent } from './events';
import { recordObservation } from './identity';
import { WorkItemControl, type WorkItemCore } from './control';
import { WorkItemTasks } from './tasks';
import { WorkItemTriage } from './triage';
import { WorkItemAnalysis } from './analysis-runner';
import { WorkItemObservations } from './observations';
import { WorkItemReview } from './review';
import { WorkItemTicker } from './ticker';

/** All state transitions are serialized. Model execution happens outside the lock. */
export class WorkItemService<C extends WorkItemConfig = WorkItemConfig> {
  private closing?: Promise<void>;
  private control: WorkItemControl;
  private lifecycle: WorkItemLifecycle;
  private tasks: WorkItemTasks;
  private triage: WorkItemTriage;
  private analysis: WorkItemAnalysis;
  private observations: WorkItemObservations;
  private reviews: WorkItemReview;
  private ticker: WorkItemTicker;
  private get ownerKey(): string { return this.config.ownerKey; }
  get lastError(): string | undefined { return this.control.lastError; }
  set lastError(value: string | undefined) { this.control.lastError = value; }
  constructor(readonly store: WorkItemStore, readonly config: C, private io: WorkItemRuntime, now = Date.now,
    queue = new WorkItemScheduler(), triageQueue = new WorkItemScheduler(WORK_ITEM_CONCURRENCY_DEFAULTS.triage)) {
    const control = this.control = new WorkItemControl(config);
    this.tasks = new WorkItemTasks(control, queue, triageQueue, {
      analysis: () => this.analysis.dispatchNext(), triage: () => this.triage.dispatchNext(),
    });
    const lifecycle = this.lifecycle = new WorkItemLifecycle(config, now, job => {
      this.tasks.analyses.get(job.id)?.controller.abort();
    }, job => {
      this.triage.forget(job.id);
      this.tasks.screenings.get(job.id)?.controller.abort();
    });
    const source = this.source = io.source;
    const delivery = new WorkItemDelivery(store, config, io, now, {
      transaction: fn => control.serial(fn), blocked: () => control.blocked(),
      safe: job => source.safe(job), accepts: job => source.accepts(job),
      get error() { return control.lastError; }, set error(value) { control.lastError = value; },
    });
    const core: WorkItemCore<C> = { store, config, io, now, source, control, lifecycle, delivery };
    this.triage = new WorkItemTriage(core, this.tasks);
    this.analysis = new WorkItemAnalysis(core, this.tasks);
    this.observations = new WorkItemObservations(core, this.tasks);
    this.reviews = new WorkItemReview(core, this.tasks);
    this.ticker = new WorkItemTicker(core, this.tasks);
    source.attach({
      get items() { return store.data.jobs; }, get cursors() { return store.data.cursors; }, get seen() { return store.data.seen; },
      save: () => store.save(),
      create: (seed, automatic) => {
        if (store.data.jobs.filter(j => !resolved(j) && j.attention?.state !== 'quiet').length >= 500) throw new Error('待办已达 500 项，暂停采集，请先处理或忽略已有待办');
        const job: WorkItem = { ...seed, id: randomUUID(), ownerKey: config.ownerKey,
          profile: config.executorProfile, target: { ...config.target }, sourceRef: { ...seed.sourceRef },
          state: automatic ? 'waiting' : 'queued', analysisRequested: !automatic,
          attention: { state: automatic ? 'pending' : 'needed', reason: automatic ? '等待关注筛选' : '你主动选择了此会话' },
          createdAt: now(), updatedAt: now(), revision: 0, handlingState: 'open', automatic };
        recordObservation(job); store.data.jobs.push(job); return job;
      },
      transition: (item, event) => {
        const job = store.data.jobs.find(j => j === item);
        if (!job) throw new Error('事项不属于当前来源');
        lifecycle.transition(job, event);
      },
      get closed() { return control.stopped; },
      get error() { return control.lastError; }, set error(value) { control.lastError = value; },
      observe: event => this.observe(event),
      transaction: fn => control.serial(fn), blocked: () => control.blocked(), assertEnabled: () => control.assertEnabled(),
      dispatch: () => this.tasks.dispatch(),
      abort: kind => this.tasks.abort(kind),
      clearAssessmentProgress: () => this.triage.clearProgress(),
      suspend: () => { control.modeChanges++; }, resume: () => { control.modeChanges--; },
    });
  }
  readonly source: SourceAdapter;
  async start(): Promise<void> {
    if (this.config.enabled) await this.io.checkAccess();
    await this.store.load();
    const key = `${this.config.executorProfile}:${this.ownerKey}`;
    if (this.store.data.ownerKey && this.store.data.ownerKey !== key) throw new Error('待办归属已改变，请为新账号使用独立状态目录');
    this.store.data.ownerKey = key;
    this.ticker.removeFeedback();
    for (const job of this.store.data.jobs) {
      if (this.io.resumeInterrupted && job.restartPending && !resolved(job) && this.source.accepts(job) &&
        job.businessState !== 'resolved' && job.external && job.external.analysisAttempts < job.external.maxAttempts && !job.draftEdited) {
        job.state = 'queued'; job.analysisRequested = true; job.analysisPaused = false; job.error = undefined;
      }
      job.restartPending = undefined;
      if (handlingState(job) === 'ignored' && (job.attention?.state !== 'quiet' || job.attention.retry || job.analysisRequested)) {
        this.lifecycle.ignore(job); this.lifecycle.touch(job);
      }
    }
    this.source.initialize?.();
    await this.setMode(this.config.enabled ? 'on' : 'off');
    this.ticker.start();
  }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.control.stopped = true;
    this.ticker.stop();
    this.tasks.abort();
    this.io.cancel?.();
    let sourceError: unknown;
    try { await this.source.close?.(); } catch (error) { sourceError = error; }
    await Promise.all(this.tasks.running().map(task => task.done));
    await this.ticker.settle();
    await this.tasks.settled;
    await this.control.pending;
    if (sourceError) throw sourceError;
  }
  list(limit = 100): WorkItem[] {
    const jobs = structuredClone(this.store.data.jobs).reverse();
    for (const job of jobs) this.triage.withProgress(job);
    return [...jobs.filter(j => !resolved(j) && j.attention?.state === 'needed'),
      ...jobs.filter(j => !resolved(j) && j.attention?.state !== 'needed' && j.attention?.state !== 'quiet'),
      ...jobs.filter(j => !resolved(j) && j.attention?.state === 'quiet'), ...jobs.filter(resolved)].slice(0, limit);
  }
  get(id: string): WorkItem | undefined {
    const job = this.store.data.jobs.find(j => j.id === id && j.ownerKey === this.ownerKey);
    return job ? this.triage.withProgress(structuredClone(job)) : undefined;
  }
  async setMode(mode: WorkItemMode, persist?: () => Promise<void>): Promise<void> {
    if (!['off', 'on'].includes(mode)) throw new Error('无效运行模式');
    this.control.modeChanges++; this.source.invalidate();
    if (mode === 'off') { this.tasks.abort(); this.io.cancelPending?.(); this.triage.clearProgress(); }
    try {
      await this.control.serial(async () => {
        if (this.control.stopped) throw new Error('助理连接已关闭');
        await persist?.();
        const previous = this.config.enabled ? 'on' : 'off';
        this.config.enabled = mode === 'on';
        this.source.modeChanged?.(previous, mode);
        await this.store.save();
      });
    } finally { this.control.modeChanges--; }
  }
  async observe(event: WorkItemEvent): Promise<WorkItem> {
    return (await this.observations.record([event]))[0]!;
  }
  /** State the source's collector committed last with its observations. */
  get collectorState(): unknown { return structuredClone(this.store.data.collector); }
  /** Records observations and the collector's read state in one store write; nothing is kept if it fails. */
  async commit(events: readonly WorkItemEvent[], state: unknown): Promise<WorkItem[]> {
    return this.observations.record(events, { value: structuredClone(state) });
  }
  decide(id: string, action: string, owner: string): Promise<void> { return this.reviews.decide(id, action, owner); }
  stopAnalysis(value: unknown, owner: string, requestId?: string): Promise<WorkItem> { return this.reviews.stopAnalysis(value, owner, requestId); }
  review(value: unknown, owner: string, requestId: string): Promise<WorkItem> { return this.reviews.review(value, owner, requestId); }
  batchReview(value: unknown, owner: string, requestId?: string): Promise<void> { return this.reviews.batchReview(value, owner, requestId); }
  tick(): Promise<void> { return this.ticker.tick(); }
}
