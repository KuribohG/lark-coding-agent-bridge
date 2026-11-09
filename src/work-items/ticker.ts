import type { WorkItemConfig } from './config';
import type { WorkItemCore } from './control';
import { evidenceSignature as signature } from './identity';
import { resolved } from './result';
import type { WorkItemTasks } from './tasks';

/** The once-a-second cycle: collection, housekeeping, delivery passes, dispatch and history refresh. */
export class WorkItemTicker {
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private refreshing?: Promise<void>;
  private notifying?: Promise<void>;
  private delivering?: Promise<void>;
  private digesting?: Promise<void>;
  private ticking?: Promise<void>;
  constructor(private core: WorkItemCore<WorkItemConfig>, private tasks: WorkItemTasks) {}
  start(): void {
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1000);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); }
  /** Waits for every in-flight pass the cycle started. */
  async settle(): Promise<void> {
    await this.polling;
    await this.refreshing;
    await this.notifying;
    await this.ticking;
    await this.delivering;
    await this.digesting;
  }
  removeFeedback(): void {
    const { store, source } = this.core;
    source.reconcile();
    if (store.data.notificationOutbox?.jobs.some(entry => {
      const job = store.data.jobs.find(j => j.id === entry.id);
      return !job || !source.safe(job) || signature(job) !== entry.signature;
    })) store.data.notificationOutbox = undefined;
  }
  tick(): Promise<void> {
    // Collection, history refresh and dispatch each have at most one in-flight pass.
    const cycle = this.ticking ??= this.runTick().finally(() => { this.ticking = undefined; });
    // Callers can await delivery, but a slow send must not stall the next collection pass.
    return cycle.then(async () => { await Promise.all([this.delivering, this.digesting]); });
  }
  private async runTick(): Promise<void> {
    const { store, control, io, source, delivery } = this.core;
    if (control.blocked()) return;
    if (!this.polling) this.polling = (source.poll?.() ?? Promise.resolve()).finally(() => { this.polling = undefined; });
    await this.polling;
    if (!this.notifying && io.notifyChange && !control.blocked()) this.notifying = delivery.changes()
      .catch(() => { this.tasks.pauseAfterFailure(); }).finally(() => { this.notifying = undefined; });
    await control.serial(async () => {
      if (control.blocked()) return;
      try {
        this.removeFeedback();
        const now = this.core.now();
        for (const job of store.data.jobs) {
          if (job.state === 'notifying' || (job.state === 'queued' && !job.analysisRequested)) job.state = 'waiting';
        }
        // Keep durable state bounded; retain active jobs regardless of age.
        const quiet = new Set(store.data.jobs.filter(j => !resolved(j) && j.attention?.state === 'quiet').slice(-500).map(j => j.id));
        store.data.jobs = store.data.jobs.filter(j => resolved(j) ? now - j.updatedAt < 7 * 86400_000 : j.attention?.state !== 'quiet' || quiet.has(j.id));
        for (const [id, time] of Object.entries(store.data.seen)) if (now - time > 2 * 86400_000) delete store.data.seen[id];
        await store.save();
      } catch (e) { control.lastError = e instanceof Error ? e.message : 'inbox poll failed'; }
    });
    if (!this.delivering && !control.blocked()) this.delivering = delivery.results()
      .catch(() => { this.tasks.pauseAfterFailure(); }).finally(() => { this.delivering = undefined; });
    if (!this.digesting && !control.blocked()) this.digesting = delivery.attention()
      .catch(() => { this.tasks.pauseAfterFailure(); }).finally(() => { this.digesting = undefined; });
    await this.tasks.dispatch();
    if (!this.refreshing && !control.blocked()) {
      this.refreshing = (source.refresh?.() ?? Promise.resolve()).finally(() => { this.refreshing = undefined; });
    }
  }
}
