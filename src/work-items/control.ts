import type { WorkItemConfig } from './config';
import type { WorkItemRuntime, SourceAdapter } from './contracts';
import type { WorkItemDelivery } from './delivery';
import type { WorkItemLifecycle } from './lifecycle';
import type { WorkItemStore } from './store';

/** Serializes state transitions and tracks whether the service may act. */
export class WorkItemControl {
  private chain: Promise<unknown> = Promise.resolve();
  stopped = false;
  modeChanges = 0;
  lastError?: string;
  constructor(private config: WorkItemConfig) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p;
  }
  /** The tail of the transition chain at the time of reading. */
  get pending(): Promise<unknown> { return this.chain; }
  blocked(): boolean { return this.stopped || !this.config.enabled || this.modeChanges > 0; }
  assertEnabled(): void { if (this.blocked()) throw new Error('助理已关闭或正在切换模式'); }
}

/** What every collaborator of one work-item service shares. */
export interface WorkItemCore<C extends WorkItemConfig = WorkItemConfig> {
  store: WorkItemStore;
  config: C;
  io: WorkItemRuntime;
  now: () => number;
  source: SourceAdapter;
  control: WorkItemControl;
  lifecycle: WorkItemLifecycle;
  delivery: WorkItemDelivery;
}
