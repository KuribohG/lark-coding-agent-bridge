import type { WorkItem } from '../work-items/types';
import type { InvestigationDriver } from '../work-items/contracts';
export type { WorkItemEvent as InboxTaskEvent } from '../work-items/events';
export type { AnalysisResult as InboxTaskResult, PreparedInvestigation as PreparedInboxTask } from '../work-items/contracts';
export { WorkItemScheduler as InboxAnalysisQueue } from '../work-items/scheduler';

/** Compatibility name for existing collector registration. */
export interface InboxTaskDriver extends InvestigationDriver {
  accepts(job: WorkItem): boolean;
}
