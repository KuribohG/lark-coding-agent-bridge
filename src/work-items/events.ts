import type { WorkItem } from './types';

/** Collectors publish full snapshots. Revisions increase within a source/key partition. */
export interface WorkItemEvent {
  key: string;
  title: string;
  reason: string;
  url: string;
  time: number;
  data: unknown;
  eventId?: string;
  revision?: number;
  operation?: 'upsert' | 'resolve';
  priority?: 'normal' | 'high';
  evidenceDir?: string;
  maxAttempts?: number;
  /** Source-owned alert/recovery text, delivered independently of analysis slots. */
  notice?: string;
  /** Used only when importing a previously unseen item. */
  initial?: Partial<Pick<WorkItem, 'state' | 'replyDraft' | 'analysis' | 'missingInfo' | 'result' | 'error' |
    'analysisTopic' | 'deliveredAt' | 'startDelivery' | 'resultDelivery' | 'inputTokens' | 'outputTokens' | 'attempt' | 'businessState'>>;
}
