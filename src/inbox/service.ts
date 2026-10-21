import type { InboxConfig, IntakeScope } from './config';
import type { InboxIO } from './types';
import type { InboxStore } from './store';
import type { InboxAnalysisQueue } from './task-source';
import { WorkItemService } from '../work-items/service';
import type { WorkItemRuntime } from '../work-items/contracts';
import { larkRuntime } from '../monitoring/sources/lark/runtime';
import { LarkSource } from '../monitoring/sources/lark/source';
export { boundMessages } from '../monitoring/sources/lark/source';

/** Compatibility facade for existing UI commands and test integrations. */
export class InboxService extends WorkItemService {
  declare readonly config: InboxConfig;
  constructor(store: InboxStore, config: InboxConfig, io: InboxIO | WorkItemRuntime, now = Date.now, queue?: InboxAnalysisQueue, triageQueue?: InboxAnalysisQueue) {
    const runtime = 'investigate' in io ? io : larkRuntime(config, io, now);
    super(store, config, runtime, now, queue, triageQueue);
  }
  async setScope(scope: IntakeScope, persist?: () => Promise<void>): Promise<void> {
    if (!(this.source instanceof LarkSource)) throw new Error('此来源不支持会话接收范围');
    await this.source.setScope(scope, persist);
  }
  async manual(chatId: string, requestId?: string) {
    if (!(this.source instanceof LarkSource)) throw new Error('此来源不支持手动选择会话');
    return this.source.manual(chatId, requestId);
  }
}
