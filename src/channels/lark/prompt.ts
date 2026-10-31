import type { NormalizedMessage } from '@larksuite/channel';
import {
  buildAgentPrompt,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
} from '../../agent/prompt';
import type { ChatMode } from '../../bot/chat-mode-cache';
import type { QuotedContext } from '../../bot/quote';
import { toPromptAttachment } from '../../media/attachment';
import type { LocalAttachment } from '../../media/cache';

export function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  topicContext: QuotedContext[] = [],
  botIdentity?: { openId: string; name?: string },
  extraInstructions?: string[],
): string {
  const first = batch[0];
  if (!first) return '';

  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;
  const texts = batch
    .map((m) => {
      const text = stripAttachmentRefs(m.content, fileKeys).trim();
      if (!text) return '';
      return annotate ? `${senderAnnotation(m)} ${text}` : text;
    })
    .filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);

  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...(first.senderName ? { senderName: first.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(first.threadId ? { threadId: first.threadId } : {}),
      messageIds: batch.map((m) => m.messageId),
      source: 'im',
    },
    instructions: extraInstructions,
    userInput: userPart,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

/**
 * Classify the sender as human or bot from the raw Feishu event
 * (`sender.sender_type`: 'user' = human, 'app' = bot). The normalizer drops
 * this field, so read it off `msg.raw` (`includeRawEvent: true` in sdk.ts).
 * Unknown / missing values return undefined — omit rather than guess.
 */
export function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  if (senderType === 'user') return 'user';
  if (senderType === 'app' || senderType === 'bot') return 'bot';
  return undefined;
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

export function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.openBotId ? { openBotId: q.openBotId } : {}),
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptTopicMessage(q: QuotedContext): BridgePromptTopicMessage {
  return {
    ...toPromptQuote(q),
    ...(q.senderType ? { senderType: q.senderType } : {}),
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
