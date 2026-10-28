import type { AgentEvent } from '../agent/types';
import type { WorkItemTarget } from './domain';
import type { WorkItem } from './types';

export interface WorkItemProgressSink {
  event(event: AgentEvent): void;
  finish(success: boolean): Promise<void>;
}

/** Transport boundary for work-item notices, analysis targets and final results. */
export interface WorkItemDeliveryPort {
  readonly ownerKey: string;
  readonly target: WorkItemTarget;
  close?(): Promise<void> | void;
  deliver?(item: WorkItem, phase: 'pending' | 'progress' | 'result'): Promise<void>;
  beginAnalysis?(item: WorkItem, text: string): Promise<WorkItemTarget>;
  notifyChange?(
    item: WorkItem,
    notice: NonNullable<WorkItem['sourceNotices']>[number],
  ): Promise<WorkItemTarget>;
  notifyAttention?(items: WorkItem[], id: string): Promise<void>;
  progress?(item: WorkItem, signal: AbortSignal): Promise<WorkItemProgressSink | undefined>;
}
