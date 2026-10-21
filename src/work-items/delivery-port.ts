import type { AgentEvent } from '../agent/types';
import type { DeliveryTarget } from './config';
import type { WorkItem } from './types';

export interface WorkItemProgressSink {
  event(event: AgentEvent): void;
  finish(success: boolean): Promise<void>;
}

/** Transport boundary for work-item notices, topics and final results. */
export interface WorkItemDeliveryPort {
  readonly ownerKey: string;
  readonly destination: DeliveryTarget;
  close?(): Promise<void> | void;
  deliver?(item: WorkItem, phase: 'pending' | 'progress' | 'result'): Promise<void>;
  beginAnalysis?(item: WorkItem, text: string): Promise<DeliveryTarget>;
  notifyChange?(
    item: WorkItem,
    notice: NonNullable<WorkItem['sourceNotices']>[number],
  ): Promise<DeliveryTarget>;
  notifyAttention?(items: WorkItem[], id: string): Promise<void>;
  progress?(item: WorkItem, signal: AbortSignal): Promise<WorkItemProgressSink | undefined>;
}
