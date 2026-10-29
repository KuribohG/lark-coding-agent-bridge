import { log, reportMetric } from '../core/logger';

/**
 * Shared concurrency cap with foreground priority. Especially useful in topic-group
 * scenarios where each topic spawns its own run — without a cap, a single
 * busy group could trivially explode to dozens of concurrent claude
 * subprocesses, drowning RAM and Anthropic API rate limit.
 *
 * Use:
 *   const pool = new ProcessPool(() => 3);
 *   const release = await pool.acquire();
 *   try { ... } finally { release(); }
 *
 * The cap is read fresh each `acquire()`, so `/config maxConcurrentRuns`
 * takes effect for the next run that asks for a slot.
 */
export class ProcessPool {
  private active = 0;
  private background = 0;
  private readonly waiters: Array<{
    priority: 'foreground' | 'background';
    grant(release: () => void): void;
  }> = [];

  constructor(private readonly cap: () => number) {}

  async acquire(signal?: AbortSignal, priority: 'foreground' | 'background' = 'foreground'): Promise<() => void> {
    signal?.throwIfAborted();
    const release = this.tryAcquire(priority);
    if (release) return release;
    return new Promise<() => void>((resolve, reject) => {
      const waiter = { priority, grant: (lease: () => void) => {
        signal?.removeEventListener('abort', cancel);
        resolve(lease);
      } };
      const cancel = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        signal?.removeEventListener('abort', cancel);
        reject(signal?.reason);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
      this.report();
    });
  }

  tryAcquire(priority: 'foreground' | 'background' = 'foreground'): (() => void) | undefined {
    if (!this.available(priority) || this.waiters.some(waiter => waiter.priority === 'foreground')) return undefined;
    return this.lease(priority);
  }

  private available(priority: 'foreground' | 'background'): boolean {
    const cap = this.cap();
    return this.active < cap && (priority === 'foreground' || this.background < Math.max(1, cap - 1));
  }

  private lease(priority: 'foreground' | 'background'): () => void {
    this.active++;
    if (priority === 'background') this.background++;
    this.report();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (priority === 'background') this.background--;
      this.drain();
      this.report();
    };
  }

  private drain(): void {
    while (this.active < this.cap() && this.waiters.length) {
      let index = this.waiters.findIndex(waiter => waiter.priority === 'foreground');
      if (index < 0) index = this.waiters.findIndex(waiter => this.available(waiter.priority));
      if (index < 0) break;
      const waiter = this.waiters.splice(index, 1)[0]!;
      // Reserve before resolving the promise; a concurrent caller cannot steal this slot.
      waiter.grant(this.lease(waiter.priority));
    }
  }

  private report(): void {
    reportMetric('pool_active', this.active);
    reportMetric('pool_waiting', this.waiters.length);
    log.info('pool', 'state', { active: this.active, waiting: this.waiters.length, cap: this.cap() });
  }

  snapshot(): { active: number; waiting: number; cap: number } {
    return { active: this.active, waiting: this.waiters.length, cap: this.cap() };
  }
}
