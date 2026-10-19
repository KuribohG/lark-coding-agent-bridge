import type { ExecutionProfile, ExecutionProvider } from '../runtime/execution-provider';
import type { ReasoningEffort } from '../agent/model-settings';
import type { SourceAdapter, RuleAssessmentPolicy, InvestigationDriver } from '../work-items/contracts';
import type { WorkItem } from '../work-items/types';
import type { WorkItemSourceOptions } from '../work-items/registry';
import type { MonitorNotification } from './notification';

export interface MonitorSourceOptions {
  id: string; label: string; profile: string; enabled: boolean;
  executor(): ExecutionProfile | undefined;
  lane?: 'normal' | 'incident';
  sourceNotifications?: boolean;
  muted?: boolean;
  dailyAnalysisLimit?: number;
  resumeInterrupted?: boolean;
  status?: () => { error?: string; health?: { checkedAt?: number; checks: { id: string; state: string; detail: string; lastSuccessAt?: number }[] } };
  notification?: MonitorNotification;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  source?: SourceAdapter;
  assessment?: RuleAssessmentPolicy;
  driver: InvestigationDriver & { accepts?(item: WorkItem): boolean };
}

export interface MonitorHost {
  executors: ExecutionProvider;
  source(options: MonitorSourceOptions): WorkItemSourceOptions;
}
