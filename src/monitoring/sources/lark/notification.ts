import type { MonitorNotification } from '../../notification';
import { validateNotification } from '../../notification';

/** Lark-owned validation for Feishu open_id/chat/topic/message identifiers. */
export function validateLarkNotification(
  notification: MonitorNotification,
  executorProfile: string,
): void {
  validateNotification(notification, executorProfile);
  const { recipientKey, target } = notification;
  if (target.transport !== 'lark') {
    throw new Error('Lark 通知目标 transport 必须为 lark');
  }
  if (!/^ou_[\w]+$/.test(recipientKey)) {
    throw new Error('请设置用户 Open ID');
  }
  if (
    !/^oc_\w+$/.test(target.containerId) ||
    !/^omt_\w+$/.test(target.threadId ?? '') ||
    !/^om_\w+$/.test(target.replyTo ?? '')
  ) {
    throw new Error('请设置结果群 ID、话题 ID 和话题内的回复消息 ID');
  }
}
