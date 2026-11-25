import type { CommandChannel } from '../../commands/types';

/**
 * The Web chat answers commands in the HTTP response, so its channel collects
 * replies instead of sending them: the endpoint returns what the handler said.
 */
export interface WebCommandChannel {
  channel: CommandChannel;
  /** Everything the command replied, in order, as plain text; undefined when it stayed silent. */
  reply(): string | undefined;
  /** The same replies as the handler wrote them, in Markdown, for a client that renders it. */
  markdown(): string | undefined;
}

export function createWebCommandChannel(): WebCommandChannel {
  const replies: string[] = [];
  return {
    channel: {
      async send(_recipientId, content) {
        if (!('markdown' in content)) throw new Error('Web replies support text only');
        replies.push(content.markdown);
        return { messageId: `reply-${replies.length}` };
      },
      async sendCard() {
        throw new Error('The Web chat has no card messages');
      },
      async updateCard() {
        throw new Error('The Web chat has no card messages');
      },
    },
    // A client that shows the reply as it comes would show the emphasis markers as noise.
    reply: () => (replies.length > 0
      ? replies.map(reply => reply.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1')).join('\n\n') : undefined),
    markdown: () => (replies.length > 0 ? replies.join('\n\n') : undefined),
  };
}
