import type { InboxMessage } from './types';

export function messageIdentity(message: InboxMessage, ownerOpenId?: string) {
  return { senderId: message.senderId, sender: message.senderName, mentions: message.mentions,
    mentionDetails: message.mentionDetails,
    ...(ownerOpenId ? { senderIsOwner: message.senderId === ownerOpenId,
      mentionsOwner: message.mentions.includes(ownerOpenId) } : {}) };
}
