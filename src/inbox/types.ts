import type { InboxConfig } from './config';

export interface InboxMessage {
  id: string; chatId: string; chatName: string; chatType: 'p2p' | 'group';
  senderId: string; senderOpenId?: string; senderName: string; bot: boolean;
  time: number; text: string; threadId?: string; parentId?: string; link?: string;
  position?: string;
  mentions: string[];
  mentionDetails?: { openId: string; name: string; key?: string }[];
  incidentId?: string; recovered?: boolean;
}

export interface Attention {
  state: 'pending' | 'needed' | 'quiet' | 'uncertain';
  reason: string;
  priority?: 'normal' | 'high';
  /** Message IDs whose structured mentions were checked against the owner ID. */
  ownerMentionMessageIds?: string[];
  /** Execution failures stay pending; genuine uncertainty is a completed decision. */
  retry?: { attempts: number; nextAt: number; error: string };
  /** Transient output preview; not a final decision and never persisted to the store. */
  progress?: { startedAt: number; updatedAt: number; text: string };
}
export type TriageDecision = Attention & { id: string; followUp?: 'unchanged' | 'reanalyze' | 'resolved' };
export type { WorkItem as InboxJob, WorkItemState as InboxState } from '../work-items/types';
import type { WorkItem as InboxJob } from '../work-items/types';

export interface InboxIO {
  /** A source partition never performs chat intake or personal attention screening. */
  taskSource?: { id: string; accepts(job: InboxJob): boolean };
  /** Trusted app/open IDs of this bridge bot; never the human owner ID. */
  selfSenderIds?: readonly string[];
  cancel?(): void;
  cancelPending?(): void;
  checkOwner(owner: string): Promise<void>;
  collect(kind: 'p2p' | 'mention' | 'group', start: number, end: number): Promise<InboxMessage[]>;
  context(chatId: string, start: number, end: number): Promise<InboxMessage[]>;
  source(chatId: string): Promise<{ name: string; type: 'p2p' | 'group' }>;
  deliver(job: InboxJob, phase: 'pending' | 'progress' | 'result'): Promise<void>;
  beginAnalysis?(job: InboxJob, text: string): Promise<InboxConfig['destination']>;
  triage?(job: InboxJob, signal: AbortSignal, onProgress?: (text: string) => void): Promise<TriageDecision>;
  notifyAttention?(jobs: InboxJob[], id: string): Promise<void>;
  analyze(job: InboxJob, signal: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}
