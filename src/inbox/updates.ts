import { createHash } from 'node:crypto';
import type { InboxJob, InboxMessage, TriageDecision } from './types';

const digest = (message: InboxMessage) => createHash('sha256').update(message.text).digest('hex');

export function messageBasis(messages: InboxMessage[]): Record<string, string> {
  return Object.fromEntries(messages.map(message => [message.id, digest(message)]));
}

export function analysisChanges(job: InboxJob): InboxMessage[] {
  return job.result ? job.messages.filter(message => job.analysisBasis?.messages[message.id] !== digest(message)) : [];
}

export function previousAnalysis(job: InboxJob) {
  if (!job.result) return undefined;
  return { replyDraft: (job.replyDraft ?? '').slice(0, 6000),
    analysis: (job.analysis ?? '').slice(0, 8000), missingInfo: (job.missingInfo ?? '').slice(0, 2000),
    attention: job.analysisBasis?.attention };
}

/** A quiet addition can be unrelated to an actionable original issue, or resolve it. */
export function validFollowUp(job: InboxJob, decision: TriageDecision): boolean {
  if (['pending', 'uncertain'].includes(decision.state)) return decision.followUp === undefined;
  if (!job.result) return true;
  return decision.followUp === 'unchanged' || (decision.followUp === 'reanalyze' && decision.state === 'needed') ||
    (decision.followUp === 'resolved' && decision.state === 'quiet');
}
