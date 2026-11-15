import type { LarkChannel } from '@larksuite/channel';
import { sendManagedCard, updateManagedCard } from '../../card/managed';
import type { CommandChannel } from '../../commands/types';
import { hasGroupMsgScope } from './app-scope';
import { createBoundChat } from './group';
import { fetchKnownChats } from './lark-info';
import { lookupMessageAppLink, scopeAppLink } from './message-links';

/**
 * Lark's `CommandChannel`: commands reach the SDK only through this, so their
 * handlers do not depend on Lark types or on a connected SDK client.
 */
export function createLarkCommandChannel(channel: LarkChannel): CommandChannel {
  return {
    botName: channel.botIdentity?.name,
    send: (recipientId, content, options) => channel.send(recipientId, content, options),
    sendCard: (recipientId, card, options) => sendManagedCard(channel, recipientId, card, options),
    updateCard: (messageId, card) => updateManagedCard(channel, messageId, card),
    stream: (recipientId, content, options) => channel.stream(recipientId, content, options),
    recallMessage: messageId => channel.recallMessage(messageId),
    knownChats: () => fetchKnownChats(channel),
    messageLink: (messageId, timeoutMs) => lookupMessageAppLink(channel, messageId, timeoutMs),
    conversationLink: scopeId => scopeAppLink(scopeId),
    hasGroupMessageScope: appId => hasGroupMsgScope(channel, appId),
    createChat: async (name, inviteOpenId) => {
      try {
        return await createBoundChat({ channel, name, inviteOpenId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${message}\n\n确认 bot 已开启 \`im:chat\` 权限。`, { cause: err });
      }
    },
  };
}
