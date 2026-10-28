import type { WorkItemTarget } from '../work-items/domain';
import { choice, fail, string, table } from './validation';

export interface MonitorNotification {
  recipientKey: string;
  target: WorkItemTarget;
  deliveryMode: 'thread' | 'new_topic';
}

export const targetSchema = table({
  transport: string,
  containerId: string,
  threadId: string,
  replyTo: string,
});
export const deliveryModeSchema = choice('thread', 'new_topic');
export const notificationSchema = table({
  recipientKey: string,
  target: targetSchema,
  deliveryMode: deliveryModeSchema,
});

export function normalizeNotification(value: unknown): MonitorNotification {
  const n = (value && typeof value === 'object' ? value : {}) as Partial<MonitorNotification>;
  const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  return {
    recipientKey: str(n.recipientKey),
    target: {
      transport: str(n.target?.transport),
      containerId: str(n.target?.containerId),
      ...(str(n.target?.threadId) ? { threadId: str(n.target?.threadId) } : {}),
      ...(str(n.target?.replyTo) ? { replyTo: str(n.target?.replyTo) } : {}),
    },
    deliveryMode: n.deliveryMode === 'new_topic' ? 'new_topic' : 'thread',
  };
}

export function validateNotification(
  notification: MonitorNotification,
  executorProfile: string,
): void {
  if (!executorProfile || !notification.recipientKey) {
    fail('notification.recipientKey', '请设置执行 profile 和通知接收者');
  }
  if (!notification.target.transport || !notification.target.containerId) {
    fail('notification.target', '请设置通知 transport 和 containerId');
  }
}
