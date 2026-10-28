import type { WorkItemTarget } from '../work-items/domain';

export interface LarkTarget {
  chatId: string;
  threadId: string;
  replyTo: string;
}

/** Materialize the Feishu-specific fields required by reply and topic APIs. */
export function larkTarget(target: WorkItemTarget): LarkTarget {
  if (target.transport !== 'lark' || !target.containerId || !target.threadId || !target.replyTo) {
    throw new Error('飞书投递目标缺少 chatId、threadId 或 replyTo');
  }
  return { chatId: target.containerId, threadId: target.threadId, replyTo: target.replyTo };
}

export function workItemTarget(target: LarkTarget): WorkItemTarget {
  return {
    transport: 'lark',
    containerId: target.chatId,
    threadId: target.threadId,
    replyTo: target.replyTo,
  };
}
