import { WORK_ITEM_CONCURRENCY_DEFAULTS } from './concurrency';
const DEFAULT_WORK_ITEM_CONCURRENCY = WORK_ITEM_CONCURRENCY_DEFAULTS.analysis;

/** Reusable FIFO execution slots, shared across sources within each task kind. */
export class WorkItemScheduler {
  private active = 0;
  private waiting: (() => void)[] = [];
  private limit: number;
  constructor(concurrency = DEFAULT_WORK_ITEM_CONCURRENCY) {
    this.limit = concurrency;
    this.resize(concurrency);
  }
  get concurrency(): number { return this.limit; }
  resize(concurrency: number): void {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid work item concurrency');
    this.limit = concurrency;
    this.drain();
  }
  private drain(): void {
    while (this.active < this.limit && this.waiting.length) this.waiting.shift()!();
  }
  private acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(true); }
    return new Promise(resolve => {
      const start = () => { signal.removeEventListener('abort', cancel); this.active++; resolve(true); };
      const cancel = () => {
        this.waiting.splice(this.waiting.indexOf(start), 1);
        signal.removeEventListener('abort', cancel); resolve(false);
      };
      this.waiting.push(start);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  async run(signal: AbortSignal, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const acquired = await this.acquire(signal);
    try {
      // Let the lifecycle record cancellation even when it never acquired a slot.
      await task(signal);
    } finally {
      if (acquired) {
        this.active--;
        this.drain();
      }
    }
  }
}
