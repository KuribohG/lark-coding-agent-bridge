import type { CommandChannel } from '../../commands/types';

/**
 * The Web chat answers commands in the HTTP response, so its channel collects
 * replies instead of sending them: the endpoint returns what the handler said.
 */
export interface WebCommandChannel {
  channel: CommandChannel;
  /** Everything the command replied, in order; undefined when it stayed silent. */
  reply(): string | undefined;
}

export function createWebCommandChannel(): WebCommandChannel {
  const replies: string[] = [];
  return {
    channel: {
      async send(_recipientId, content) {
        if (!('markdown' in content)) throw new Error('Web replies support text only');
        // The page shows replies as plain text, so emphasis markers would be noise.
        replies.push(content.markdown.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1'));
        return { messageId: `reply-${replies.length}` };
      },
      async sendCard() {
        throw new Error('The Web chat has no card messages');
      },
      async updateCard() {
        throw new Error('The Web chat has no card messages');
      },
    },
    reply: () => (replies.length > 0 ? replies.join('\n\n') : undefined),
  };
}
