import type { InboxConfig } from './config';

export interface InboxMessage {
  id: string; chatId: string; chatName: string; chatType: 'p2p' | 'group';
  senderId: string; senderName: string; bot: boolean;
  time: number; text: string; threadId?: string; parentId?: string; link?: string;
  position?: string;
  mentions: string[];
  incidentId?: string; recovered?: boolean;
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
}

export interface InboxIO {
  cancel?(): void;
  cancelPending?(): void;
  checkOwner(owner: string): Promise<void>;
  collect(kind: 'p2p' | 'mention' | 'group', start: number, end: number): Promise<InboxMessage[]>;
  context(chatId: string, start: number, end: number): Promise<InboxMessage[]>;
  source(chatId: string): Promise<{ name: string; type: 'p2p' | 'group' }>;
  deliver(job: InboxJob, phase: 'pending' | 'progress' | 'result'): Promise<void>;
  analyze(job: InboxJob, signal: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}
