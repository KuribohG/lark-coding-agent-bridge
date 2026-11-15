import type { NormalizedMessage } from '@larksuite/channel';
import type { AgentEntry } from '../../runtime/agent-entry';
import { PendingQueue as InputQueue, type FlushHandler as InputFlushHandler } from '../../runtime/pending-queue';

export { MAX_PENDING_CHARS_PER_SCOPE } from '../../runtime/pending-queue';

/** Routing metadata is set by the bridge command handler, never parsed from message text. */
export type PendingMessage = NormalizedMessage & { agentEntry?: AgentEntry };

export type FlushHandler = InputFlushHandler<PendingMessage>;

/**
 * An input the bridge makes itself (card click, late question answer) rather
 * than receives. `anchor.messageId` is the Lark message it came from: the turn
 * replies to, reacts on and reports that id, so it must be a real message —
 * keys that only tell inputs apart belong elsewhere.
 */
export function bridgeInput(
  anchor: Pick<NormalizedMessage, 'messageId' | 'chatId' | 'chatType' | 'threadId' | 'senderId' | 'senderName'>,
  content: string,
): PendingMessage {
  return {
    messageId: anchor.messageId, chatId: anchor.chatId, chatType: anchor.chatType,
    threadId: anchor.threadId, senderId: anchor.senderId, senderName: anchor.senderName,
    content, rawContentType: 'card_action', resources: [], mentions: [], mentionAll: false, mentionedBot: false,
    createTime: Date.now(),
  };
}

/**
 * The Lark input queue: scopes are `chatId` for p2p / regular group and
 * `chatId:threadId` for topic groups.
 */
export class PendingQueue extends InputQueue<PendingMessage> {
  constructor(delayMs: number | (() => number), onFlush: FlushHandler, path?: string) {
    super(delayMs, onFlush, path, item => typeof (item as Partial<NormalizedMessage>).chatId === 'string');
  }
}
