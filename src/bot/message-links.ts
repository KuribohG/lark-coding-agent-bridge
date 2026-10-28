import type { ApiMessageItem, LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

const APP_LINK_PREFIX = /^https:\/\/applink\.(?:feishu\.cn|larksuite\.com)\//;
const MESSAGE_ID = /^om_\w+$/;

export function isLarkAppLink(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1000 && APP_LINK_PREFIX.test(value);
}

export function scopeAppLink(scopeId: string): string | undefined {
  const separator = scopeId.indexOf(':');
  const chatId = separator === -1 ? scopeId : scopeId.slice(0, separator);
  const threadId = separator === -1 ? undefined : scopeId.slice(separator + 1);
  if (!/^oc_\w+$/.test(chatId) || (threadId !== undefined && !/^omt_\w+$/.test(threadId))) {
    return undefined;
  }
  if (!threadId) {
    return `https://applink.feishu.cn/client/chat/open?${new URLSearchParams({
      openChatId: chatId,
    })}`;
  }
  return `https://applink.feishu.cn/client/thread/open?${new URLSearchParams({
    open_chat_id: chatId,
    open_thread_id: threadId,
  })}`;
}

export async function lookupMessageAppLink(
  channel: Pick<LarkChannel, 'fetchRawMessage'>,
  messageId: string,
  timeoutMs = 2_000,
): Promise<string | undefined> {
  if (!MESSAGE_ID.test(messageId)) return undefined;

  let timer: NodeJS.Timeout | undefined;
  try {
    const lookup = channel.fetchRawMessage(messageId)
      .then((items) => {
        const parent = items.find((item) => item.message_id === messageId) ?? items[0];
        const link = (parent as ApiMessageItem & { message_app_link?: unknown } | undefined)
          ?.message_app_link;
        return isLarkAppLink(link) ? link : undefined;
      })
      .catch((err: unknown) => {
        log.warn('message-link', 'lookup-failed', {
          messageId,
          err: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      });
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref();
    });
    return await Promise.race([lookup, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
