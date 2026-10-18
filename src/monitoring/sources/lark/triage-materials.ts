import { INBOX_DEFAULTS, normalizeInbox, type InboxConfig } from '../../../inbox/config';
import type { InboxJob, InboxMessage } from '../../../inbox/types';
import { analysisChanges, previousAnalysis } from '../../../inbox/updates';

export type TriageExcerptConfig = Pick<InboxConfig, 'triageMessageLimit' | 'triageMessageChars'>;

function progressOnly(message: InboxMessage): boolean {
  if (!message.bot) return false;
  return /^(?:No active task to stop\.|\[System: Empty message content sanitised to satisfy protocol\]|⏳ Working[^\n]*|💾 Self-improvement review:[^\n]*)$/u.test(message.text.trim());
}

function excerpt(message: InboxMessage, limit: number) {
  const truncated = message.text.length > limit;
  const marker = '\n[…正文截断，可按消息 ID 回查全文…]\n';
  const head = Math.ceil((limit - marker.length) / 2);
  const tail = limit - marker.length - head;
  return { id: message.id, time: new Date(message.time).toISOString(), senderId: message.senderId,
    sender: message.senderName, bot: message.bot, mentions: message.mentions, parentId: message.parentId,
    threadId: message.threadId, truncated, originalChars: message.text.length,
    text: truncated ? message.text.slice(0, head) + marker + message.text.slice(-tail) : message.text };
}

export function triageMaterials(jobs: InboxJob[], background: string, settings: TriageExcerptConfig = INBOX_DEFAULTS): string {
  const config = normalizeInbox(settings);
  return JSON.stringify({ background: background.slice(0, 3000), items: jobs.map(job => {
    const candidates = job.messages.filter(message => !progressOnly(message));
    // Keep the first retained question plus recent evidence, without duplicating short threads.
    const selected = candidates.length > config.triageMessageLimit
      ? [candidates[0]!, ...candidates.slice(-(config.triageMessageLimit - 1))] : candidates;
    const messages = selected.map(message => excerpt(message, config.triageMessageChars));
    return { id: job.id, ownerOpenId: job.ownerOpenId, source: job.source,
      directlyMentioned: job.messages.some(message => message.mentions.includes(job.ownerOpenId)),
      excerpt: selected.length < job.messages.length || messages.some(message => message.truncated),
      totalMessages: job.messages.length, omittedMessages: job.messages.length - selected.length,
      omittedProgressMessages: job.messages.length - candidates.length,
      ...(job.result ? { previousAnalysis: previousAnalysis(job),
        changes: analysisChanges(job).map(message => ({ id: message.id, time: new Date(message.time).toISOString(),
          senderId: message.senderId, sender: message.senderName, bot: message.bot, mentions: message.mentions,
          parentId: message.parentId, threadId: message.threadId, text: message.text })) } : {}),
      messages };
  }) });
}
