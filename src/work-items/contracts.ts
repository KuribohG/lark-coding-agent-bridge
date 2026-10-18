import type { AgentRunOptions } from '../agent/types';
import type { Attention, TriageDecision } from '../inbox/types';
import type { WorkItem } from './types';
import type { WorkItemStore } from './store';
import type { WorkItemEvent } from './events';

export interface SourceContext {
  store: WorkItemStore;
  readonly closed: boolean;
  error?: string;
  observe(event: WorkItemEvent): Promise<WorkItem>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  blocked(): boolean;
  assertEnabled(): void;
  dispatch(): Promise<void>;
  touch(item: WorkItem): void;
  ignore(item: WorkItem): void;
  abort(kind?: 'analysis' | 'triage'): void;
  clearAssessmentProgress(): void;
  suspend(): void;
  resume(): void;
}

/** A source owns collection and domain semantics, never the analysis queue or delivery. */
export interface SourceAdapter {
  id: string;
  acceptsEvents?: boolean;
  attach(context: SourceContext): void;
  accepts(item: WorkItem): boolean;
  safe(item: WorkItem): boolean;
  reconcile(): void;
  invalidate(): void;
  initialize?(): void;
  close?(): Promise<void> | void;
  modeChanged?(previous: 'off' | 'on', next: 'off' | 'on'): void;
  poll?(): Promise<void>;
  refresh?(): Promise<void>;
  beforeAnalysis?(item: WorkItem, signal: AbortSignal, current: () => boolean): Promise<boolean>;
  afterAnalysis?(item: WorkItem, input: WorkItem): void;
  assessment?: AssessmentPolicy;
}

/** Model screening and deterministic rules use the same decision lifecycle. */
export type AssessmentPolicy = BatchAssessmentPolicy | RuleAssessmentPolicy;
export interface RuleAssessmentPolicy {
  kind: 'rule';
  evaluate(event: WorkItemEvent): ItemDecision;
}
export interface BatchAssessmentPolicy {
  kind: 'batch';
  available?: boolean;
  select(items: WorkItem[]): WorkItem[];
  evaluate(items: WorkItem[], signal: AbortSignal,
    progress: (updates: { id: string; text: string }[]) => void): Promise<TriageDecision[]>;
  valid(input: WorkItem, decision: TriageDecision): boolean;
  apply(item: WorkItem, input: WorkItem, decision: TriageDecision): void;
}

export interface AnalysisResult {
  text: string; inputTokens: number; outputTokens: number;
  /** Set only by a trusted source preflight, never parsed from model output. */
  businessState?: 'open' | 'resolved';
}
export interface PreparedInvestigation { cwd: string; prompt: string; cached?: AnalysisResult }
export interface InvestigationDriver {
  prepare(item: WorkItem, signal: AbortSignal): Promise<PreparedInvestigation>;
  completed?(item: WorkItem, result: AnalysisResult, settings: Pick<AgentRunOptions, 'model' | 'reasoningEffort'>): Promise<void>;
}

export interface WorkItemRuntime {
  source: SourceAdapter;
  dailyAnalysisLimit?: number;
  resumeInterrupted?: boolean;
  investigate(item: WorkItem, signal: AbortSignal): Promise<AnalysisResult>;
  checkAccess(): Promise<void>;
  cancel?(): void;
  cancelPending?(): void;
  deliver(item: WorkItem, phase: 'pending' | 'progress' | 'result'): Promise<void>;
  beginAnalysis?(item: WorkItem, text: string): Promise<WorkItem['destination']>;
  notifyChange?(item: WorkItem, notice: NonNullable<WorkItem['sourceNotices']>[number]): Promise<WorkItem['destination']>;
  notifyAttention?(items: WorkItem[], id: string): Promise<void>;
}

export type ItemDecision = Pick<Attention, 'state' | 'reason' | 'priority'>;
