import type { WorkItemRuntime } from '../../../work-items/contracts';
import type { InboxConfig } from '../../../inbox/config';
import { LarkSource } from './source';
import type { InboxIO } from '../../../inbox/types';

export function larkRuntime(config: InboxConfig, io: InboxIO, now = Date.now): WorkItemRuntime {
  return {
    source: new LarkSource(config, io, now),
    checkAccess: () => io.checkOwner(config.recipientKey), investigate: (item, signal) => io.analyze(item, signal),
    cancel: () => io.cancel?.(), cancelPending: () => io.cancelPending?.(), deliver: (item, phase) => io.deliver(item, phase),
    beginAnalysis: io.beginAnalysis ? (item, text) => io.beginAnalysis!(item, text) : undefined,
    notifyAttention: io.notifyAttention ? (items, id) => io.notifyAttention!(items, id) : undefined,
  };
}
