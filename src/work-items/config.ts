export type WorkItemMode = 'off' | 'on';
import type { WorkItemTarget } from './domain';

/** Transport-neutral settings shared by every work-item source. */
export interface WorkItemConfig {
  enabled: boolean;
  executorProfile: string;
  ownerKey: string;
  target: WorkItemTarget;
  autoAnalyze: boolean;
  dailyTriageLimit: number;
  workbenchUrl?: string;
}
