import type { DeliveryTarget } from './config';
import type { Attention, InboxMessage } from '../inbox/types';

export interface WorkItem {
  /** Source identity and evidence lifecycle; populated when loading legacy records. */
  origin?: { sourceId: string; key: string; kind: string; url?: string };
  evidenceVersion?: number;
  businessState?: 'open' | 'resolved';
  analyzedVersion?: number;
  observation?: { id: string; revision: number; time: number; digest: string };
  id: string;
  ownerOpenId: string;
  profile: string;
  destination: DeliveryTarget;
  source: { chatId: string; name: string; type: 'p2p' | 'group' | 'external'; threadId?: string };
  messages: InboxMessage[];
  state: 'notifying' | 'waiting' | 'queued' | 'running' | 'ready' | 'done' | 'ignored' | 'claimed' | 'failed';
  createdAt: number; updatedAt: number; notifiedAt?: number; dueAt?: number;
  intakeTrigger?: 'private' | 'mention' | 'group';
  attention?: Attention;
  analysisRequested?: boolean;
  analysisTopic?: DeliveryTarget;
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

export interface WorkItemState {
  version: 1;
  ownerKey?: string;
  cursors: Record<string, number>;
  seen: Record<string, number>;
  jobs: WorkItem[];
  autoUsage: Record<string, number>;
  triageUsage?: Record<string, number>;
  notificationUsage?: Record<string, number>;
  lastDigestAt?: number;
  notificationOutbox?: { id: string; jobs: { id: string; signature: string }[]; attempts: number; retryAt: number };
}
