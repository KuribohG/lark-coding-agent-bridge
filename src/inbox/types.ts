import type { InboxConfig } from './config';
import type {
  EvidenceMessage as InboxMessage,
  TriageDecision,
} from '../work-items/evidence';

export type {
  Attention,
  EvidenceMessage as InboxMessage,
  TriageDecision,
} from '../work-items/evidence';
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
