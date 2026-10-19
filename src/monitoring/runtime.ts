import type { MonitorContext, MonitorController, MonitorModule } from './module';
import { WorkItemSources } from '../work-items/registry';
import { monitorModules } from './sources';

/** Owns the shared engine; modules own their collectors, timers and leases. */
export class MonitorRuntime<M extends Record<string, MonitorModule>> {
  readonly controllers: { [K in keyof M]: ReturnType<M[K]['create']> };
  readonly sources: WorkItemSources;
  private closing?: Promise<void>;

  constructor(context: Omit<MonitorContext, 'sources'>, modules: M) {
    this.sources = new WorkItemSources(context.configPath);
    this.controllers = Object.fromEntries(Object.entries(modules).map(([key, module]) =>
      [key, module.create({ ...context, sources: this.sources })])) as typeof this.controllers;
  }

  async reconcile(): Promise<void> {
    if (this.closing) return;
    // A slow or failed source cannot prevent another source from seeing profile changes.
    const results = await Promise.allSettled(Object.values(this.controllers).map(async c => c.reconcile()));
    this.check(results);
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    const results: PromiseSettledResult<void>[] = [];
    for (const controller of Object.values<MonitorController>(this.controllers).reverse()) {
      try { await controller.close(); results.push({ status: 'fulfilled', value: undefined }); }
      catch (reason) { results.push({ status: 'rejected', reason }); }
    }
    try { await this.sources.close(); }
    catch (reason) { results.push({ status: 'rejected', reason }); }
    this.check(results);
  }

  private check(results: PromiseSettledResult<void>[]): void {
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), 'Monitor lifecycle failed');
  }
}

export const createMonitorRuntime = (context: Omit<MonitorContext, 'sources'>) => new MonitorRuntime(context, monitorModules);
