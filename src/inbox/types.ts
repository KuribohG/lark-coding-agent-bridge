import type { InboxConfig } from './config';

export interface InboxMessage {
  id: string; chatId: string; chatName: string; chatType: 'p2p' | 'group';
  senderId: string; senderName: string; bot: boolean;
  time: number; text: string; threadId?: string; parentId?: string; link?: string;
  position?: string;
  mentions: string[];
  incidentId?: string; recovered?: boolean;
}

export interface Attention {
  state: 'pending' | 'needed' | 'quiet' | 'uncertain';
  reason: string;
  priority?: 'normal' | 'high';
  /** Transient output preview; not a final decision and never persisted to the store. */
  progress?: { startedAt: number; updatedAt: number; text: string };
}
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
  lastReviewRequestId?: string;
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
  cancel?(): void;
  cancelPending?(): void;
  checkOwner(owner: string): Promise<void>;
  collect(kind: 'p2p' | 'mention' | 'group', start: number, end: number): Promise<InboxMessage[]>;
  context(chatId: string, start: number, end: number): Promise<InboxMessage[]>;
  source(chatId: string): Promise<{ name: string; type: 'p2p' | 'group' }>;
  deliver(job: InboxJob, phase: 'pending' | 'progress' | 'result'): Promise<void>;
  triage?(jobs: InboxJob[], signal: AbortSignal, onProgress?: (updates: { id: string; text: string }[]) => void): Promise<(Attention & { id: string })[]>;
  notifyAttention?(jobs: InboxJob[], id: string): Promise<void>;
  analyze(job: InboxJob, signal: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}
