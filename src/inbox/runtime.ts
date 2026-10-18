import type { WorkItemRuntime } from '../work-items/contracts';
import { EventSource } from '../work-items/event-source';
import type { InboxConfig } from './config';
import { LarkSource } from './source';
import type { InboxIO } from './types';

export function larkRuntime(config: InboxConfig, io: InboxIO, now = Date.now): WorkItemRuntime {
  return {
    source: io.taskSource ? new EventSource(io.taskSource.id, io.taskSource.accepts) : new LarkSource(config, io, now),
    checkAccess: () => io.checkOwner(config.ownerOpenId), investigate: (item, signal) => io.analyze(item, signal),
    cancel: () => io.cancel?.(), cancelPending: () => io.cancelPending?.(), deliver: (item, phase) => io.deliver(item, phase),
    beginAnalysis: io.beginAnalysis ? (item, text) => io.beginAnalysis!(item, text) : undefined,
    notifyAttention: io.notifyAttention ? (items, id) => io.notifyAttention!(items, id) : undefined,
  };
}
