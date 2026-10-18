import type { InboxConfig } from './config';

export interface InboxMessage {
  id: string; chatId: string; chatName: string; chatType: 'p2p' | 'group';
  senderId: string; senderOpenId?: string; senderName: string; bot: boolean;
  time: number; text: string; threadId?: string; parentId?: string; link?: string;
  position?: string;
  mentions: string[];
  incidentId?: string; recovered?: boolean;
}

export interface Attention {
  state: 'pending' | 'needed' | 'quiet' | 'uncertain';
  reason: string;
  priority?: 'normal' | 'high';
  /** Execution failures stay pending; genuine uncertainty is a completed decision. */
  retry?: { attempts: number; nextAt: number; error: string };
  /** Transient output preview; not a final decision and never persisted to the store. */
  progress?: { startedAt: number; updatedAt: number; text: string };
}
export type TriageDecision = Attention & { id: string; followUp?: 'unchanged' | 'reanalyze' | 'resolved' };
export interface InboxJob {
  id: string;
  ownerOpenId: string;
  profile: string;
  destination: InboxConfig['destination'];
  source: { chatId: string; name: string; type: 'p2p' | 'group'; threadId?: string };
  messages: InboxMessage[];
  state: 'notifying' | 'waiting' | 'queued' | 'running' | 'ready' | 'done' | 'ignored' | 'claimed' | 'failed';
  createdAt: number; updatedAt: number; notifiedAt?: number; dueAt?: number;
  intakeTrigger?: 'private' | 'mention' | 'group';
  attention?: Attention;
  analysisRequested?: boolean;
  analysisTopic?: InboxConfig['destination'];
  startDelivery?: { id: string; text: string; attempts: number; startedAt: number; retryAt: number; confirmed?: boolean };
  resultDelivery?: { attempts: number; startedAt: number; retryAt: number };
  notificationSuppressed?: boolean;
  automatic: boolean; alert: boolean; result?: string; error?: string;
  inputTokens?: number; outputTokens?: number;
  deliveredAt?: number;
  attempt?: number;
  retryAt?: number;
  incidentId?: string;
  manualSignature?: string;
  manualRequestId?: string;
  manualRequestIds?: string[];
  revision?: number;
  handlingState?: 'open' | 'handled' | 'ignored';
  replyDraft?: string;
  analysis?: string;
  missingInfo?: string;
  draftEdited?: boolean;
  draftStale?: boolean;
  /** Messages covered by the completed analysis or its last incremental review. */
  analysisBasis?: { messages: Record<string, string>; attention: Attention };
  /** Only an explicit process request releases a stopped or interrupted analysis. */
  analysisPaused?: boolean;
  lastReviewRequestId?: string;
  /** Events from configured watchers use the same lifecycle as conversation jobs. */
  external?: {
    source: string; key: string; url: string; data: unknown;
    analysisAttempts: number; maxAttempts: number; evidenceDir?: string;
  };
}

export interface InboxState {
  version: 1;
  ownerKey?: string;
  cursors: Record<string, number>;
  seen: Record<string, number>;
  jobs: InboxJob[];
  autoUsage: Record<string, number>;
  triageUsage?: Record<string, number>;
  notificationUsage?: Record<string, number>;
  lastDigestAt?: number;
  notificationOutbox?: { id: string; jobs: { id: string; signature: string }[]; attempts: number; retryAt: number };
}

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
  triage?(jobs: InboxJob[], signal: AbortSignal, onProgress?: (updates: { id: string; text: string }[]) => void): Promise<TriageDecision[]>;
  notifyAttention?(jobs: InboxJob[], id: string): Promise<void>;
  analyze(job: InboxJob, signal: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}
