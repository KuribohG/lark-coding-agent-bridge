import type { DeliveryTarget } from '../work-items/config';
import { choice, string, table } from './validation';

export interface MonitorNotification {
  ownerOpenId: string;
  destination: DeliveryTarget;
  deliveryMode: 'thread' | 'new_topic';
}

export const destinationSchema = table({ chatId: string, threadId: string, replyTo: string });
export const deliveryModeSchema = choice('thread', 'new_topic');
export const notificationSchema = table({ ownerOpenId: string, destination: destinationSchema, deliveryMode: deliveryModeSchema });

export function normalizeNotification(value: unknown): MonitorNotification {
  const n = (value && typeof value === 'object' ? value : {}) as Partial<MonitorNotification>;
  const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  return { ownerOpenId: str(n.ownerOpenId), deliveryMode: n.deliveryMode === 'new_topic' ? 'new_topic' : 'thread',
    destination: { chatId: str(n.destination?.chatId), threadId: str(n.destination?.threadId), replyTo: str(n.destination?.replyTo) } };
}

export function validateNotification(n: MonitorNotification, executorProfile: string): void {
  if (!executorProfile || !/^ou_[\w]+$/.test(n.ownerOpenId)) throw new Error('请设置执行 profile 和用户 Open ID');
  if (!/^oc_\w+$/.test(n.destination.chatId) || !/^omt_\w+$/.test(n.destination.threadId) || !/^om_\w+$/.test(n.destination.replyTo)) {
    throw new Error('请设置结果群 ID、话题 ID 和话题内的回复消息 ID');
  }
}
