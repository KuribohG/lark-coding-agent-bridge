import type { InboxConfig } from '../../../inbox/config';
import type { InboxJob, InboxMessage } from '../../../inbox/types';
import { larkTarget } from '../../../inbox/lark-target';
import { handlingState } from '../../../work-items/result';

const resolved = (job: InboxJob) => handlingState(job) !== 'open';
const mentioned = (message: InboxMessage, key: string) => message.mentions.some(mention => mention.id === key);
export const incidentId = (message: InboxMessage) =>
  typeof message.metadata?.incidentId === 'string' ? message.metadata.incidentId : undefined;
const recovered = (message: InboxMessage) => message.metadata?.recovered === true;

/** Chat order: the sequence within one chat, otherwise time. */
export function compareMessages(a: InboxMessage, b: InboxMessage): number {
  if (a.containerId === b.containerId && /^\d+$/.test(a.sequence ?? '') && /^\d+$/.test(b.sequence ?? '')) {
    return BigInt(a.sequence!) < BigInt(b.sequence!) ? -1 : BigInt(a.sequence!) > BigInt(b.sequence!) ? 1 : 0;
  }
  return a.time - b.time;
}

export function classifyMessage(m: InboxMessage): 'skip' | 'alert' | 'request' {
  const text = m.text.trim();
  if (!text || /^(收到|谢谢|好的|好|嗯|OK|ok|Thanks|👍|👌)[。！!\s]*$/i.test(text)) return 'skip';
  return m.senderBot || /报警|告警|alert|firing|resolved/i.test(text) ? 'alert' : 'request';
}

/** The newest messages that fit the evidence budget, in chat order. */
export function boundMessages(messages: InboxMessage[], maxChars: number): InboxMessage[] {
  const output: InboxMessage[] = [];
  let remaining = maxChars;
  for (const m of [...messages].sort((a, b) => compareMessages(b, a))) {
    if (remaining <= 0 || output.length >= 100) break;
    const text = m.text.slice(0, remaining);
    output.push({ ...m, text }); remaining -= text.length + 200;
  }
  return output.reverse();
}

/** What a newly collected message means for the conversation items of its chat. */
export type MessageRoute =
  | { kind: 'ignore' }
  /** The owner answered these items. */
  | { kind: 'handled'; items: InboxJob[] }
  /** A bot reported recovery of the incident these items track. */
  | { kind: 'recovered'; items: InboxJob[] }
  | { kind: 'append'; item: InboxJob; mention: boolean; alert: boolean }
  | { kind: 'create' };

type ConversationConfig = Pick<InboxConfig, 'recipientKey' | 'intakeScope' | 'target'>;

/**
 * The Lark conversation rules: which messages count as evidence, which items a source may
 * act on, and which item a new message belongs to. It reads items and never changes them.
 */
export class LarkConversation {
  constructor(private config: ConversationConfig, private selfSenderIds: readonly string[] = [], private now = Date.now) {}

  /** Result chats carry the assistant's own output, never evidence. */
  outputChat(chatId: string, items: readonly InboxJob[]): boolean {
    return chatId === larkTarget(this.config.target).chatId || items.some(job =>
      chatId === job.target.containerId || chatId === job.analysisTarget?.containerId);
  }

  acceptsMessage(message: InboxMessage, items: readonly InboxJob[]): boolean {
    return !this.outputChat(message.containerId, items) && !this.selfSenderIds.some(id =>
      Boolean(id) && (message.senderId === id || message.senderAliases?.includes(id)));
  }

  /** An item whose evidence is entirely acceptable and that may be processed. */
  safe(job: InboxJob, items: readonly InboxJob[]): boolean {
    return !this.outputChat(job.sourceRef.containerId, items) && job.messages.length > 0 && job.messages.every(m => this.acceptsMessage(m, items));
  }

  /** A safe item within the current intake scope. */
  accepts(job: InboxJob, items: readonly InboxJob[]): boolean {
    if (!this.safe(job, items)) return false;
    return job.sourceRef.kind === 'direct' || (this.config.intakeScope !== 'private' &&
      (this.config.intakeScope === 'all' || job.intakeTrigger === 'mention' ||
        job.messages.some(m => mentioned(m, this.config.recipientKey))));
  }

  intakeTrigger(message: InboxMessage): 'private' | 'mention' | 'group' {
    return message.containerKind === 'direct' ? 'private' : mentioned(message, this.config.recipientKey) ? 'mention' : 'group';
  }

  /** Whether the owner already answered the item in these messages. */
  answered(job: InboxJob, messages: readonly InboxMessage[]): boolean {
    return messages.some(m => m.senderId === this.config.recipientKey && compareMessages(m, job.messages.at(-1)!) > 0 &&
      (job.sourceRef.kind === 'direct' || Boolean(job.sourceRef.threadId) || job.messages.some(x => x.id === m.replyTo)));
  }

  route(m: InboxMessage, items: readonly InboxJob[]): MessageRoute {
    const key = this.config.recipientKey;
    const jobs = items.filter(j => j.sourceRef.containerId === m.containerId && !resolved(j) && this.accepts(j, items));
    if (m.senderId === key) {
      return { kind: 'handled', items: jobs.filter(job => compareMessages(m, job.messages.at(-1)!) > 0 && (m.containerKind === 'direct' ||
        (m.threadId && m.threadId === job.sourceRef.threadId) || job.messages.some(x => x.id === m.replyTo))) };
    }
    if (recovered(m) && incidentId(m) && m.senderBot) {
      return { kind: 'recovered', items: jobs.filter(job => job.incidentId === incidentId(m) && job.messages[0]?.senderId === m.senderId) };
    }
    const related = jobs.find(j => j.messages.some(x => x.id === m.id)) ??
      jobs.find(j => (m.threadId && m.threadId === j.sourceRef.threadId) || j.messages.some(x => x.id === m.replyTo));
    if (m.containerKind !== 'direct' && this.config.intakeScope !== 'all' && !mentioned(m, key) && !related) return { kind: 'ignore' };
    if (!related && m.senderBot && jobs.some(j => j.messages.at(-1)?.text === m.text && j.sourceRef.threadId === m.threadId)) return { kind: 'ignore' };
    const category = classifyMessage(m);
    if (category === 'skip' || (m.containerKind === 'direct' && m.senderBot)) return { kind: 'ignore' };
    const incident = incidentId(m);
    const previous = related ?? jobs.find(j => j.sourceRef.threadId === m.threadId &&
      (incident ? j.incidentId === incident && j.messages[0]?.senderId === m.senderId :
        !j.incidentId && (Boolean(j.result) || j.state === 'running' || this.now() - j.updatedAt < 5 * 60_000)));
    return previous ? { kind: 'append', item: previous, mention: mentioned(m, key), alert: category === 'alert' } : { kind: 'create' };
  }
}
