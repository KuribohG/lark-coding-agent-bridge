import type { CommandChannel } from '../../commands/types';
import type { SlackApi } from './api';
import { toSlackMrkdwn } from './format';

export interface SlackCommandChannelOptions {
  api: SlackApi;
  /** Slack channel of the conversation. */
  channel: string;
  /** Thread every reply belongs to. */
  threadTs: string;
  botName?: string;
}

/**
 * Slack's `CommandChannel`: replies become thread messages converted to
 * mrkdwn. Its catalogue exposes no card or streaming commands, so those
 * capabilities fail loudly instead of silently dropping output.
 */
export function createSlackCommandChannel(options: SlackCommandChannelOptions): CommandChannel {
  return {
    ...(options.botName ? { botName: options.botName } : {}),
    async send(_recipientId, content) {
      if (!('markdown' in content)) throw new Error('Slack replies support text only');
      const messageId = await options.api.postMessage({
        channel: options.channel,
        threadTs: options.threadTs,
        text: toSlackMrkdwn(content.markdown),
      });
      return { messageId };
    },
    async sendCard() {
      throw new Error('Slack has no card messages; it exposes no card commands');
    },
    async updateCard() {
      throw new Error('Slack has no card messages; it exposes no card commands');
    },
  };
}
