import { log } from '../core/logger';
import type { MonitorController } from './module';

/**
 * Serialized, periodic reconciliation shared by monitor controllers. A failed reload keeps
 * the running instance unless `recover` stops it; each distinct failure is logged once.
 */
export abstract class ReconcileLoop implements MonitorController {
  error?: string;
  /** A monitor section that kept its last good config; reported after a successful reload. */
  protected sectionError?: string;
  protected closed = false;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private reportedError?: string;

  constructor(private logTag: string, private fallbackError: string, intervalMs = 15_000) {
    this.timer = setInterval(() => { void this.reconcile(); }, intervalMs);
    this.timer.unref();
  }

  reconcile(): Promise<void> {
    if (this.closed) return this.chain;
    const next = this.chain.then(() => this.reload()).then(() => {
      if (this.sectionError) this.error = this.sectionError;
      this.reportedError = undefined;
    }).catch(async error => {
      this.error = error instanceof Error ? error.message : this.fallbackError;
      if (this.reportedError !== this.error) {
        this.reportedError = this.error;
        log.warn(this.logTag, 'setup-failed', { error: this.error });
      }
      await this.recover();
    });
    this.chain = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    await this.chain; await this.stop();
  }

  protected abstract reload(): Promise<void>;
  /** Runs after a failed reload, before the next reconciliation. */
  protected abstract recover(): Promise<void>;
  protected abstract stop(): Promise<void>;
}
