import type { InboxMessage } from './types';

export function messageIdentity(message: InboxMessage, ownerKey?: string) {
  const mentions = message.mentions.map(mention => mention.id);
  return {
    senderId: message.senderId,
    sender: message.senderName,
    mentions,
    mentionDetails: message.mentions.map(mention => ({
      openId: mention.id,
      name: mention.name,
      ...(mention.key ? { key: mention.key } : {}),
    })),
    ...(ownerKey ? {
      senderIsOwner: message.senderId === ownerKey || message.senderAliases?.includes(ownerKey) === true,
      mentionsOwner: mentions.includes(ownerKey),
    } : {}),
  };
}
