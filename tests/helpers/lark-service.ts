import type { InboxConfig } from '../../src/inbox/config';
import type { InboxIO } from '../../src/inbox/types';
import { larkRuntime } from '../../src/monitoring/sources/lark/runtime';
import { LarkSource } from '../../src/monitoring/sources/lark/source';
import type { WorkItemScheduler } from '../../src/work-items/scheduler';
import { WorkItemService } from '../../src/work-items/service';
import type { WorkItemStore } from '../../src/work-items/store';

/** A work-item service driven by the Lark conversation source, as the inbox manager builds it. */
export function larkService(store: WorkItemStore, config: InboxConfig, io: InboxIO, now = Date.now,
  queue?: WorkItemScheduler, triageQueue?: WorkItemScheduler): WorkItemService<InboxConfig> {
  return new WorkItemService(store, config, larkRuntime(config, io, now), now, queue, triageQueue);
}

/** A Lark source stand-in for callers that only use its conversation commands. */
export function stubLarkSource<T extends object>(config: InboxConfig, overrides: T): LarkSource & T {
  return Object.assign(Object.create(LarkSource.prototype) as LarkSource, { config }, overrides);
}
