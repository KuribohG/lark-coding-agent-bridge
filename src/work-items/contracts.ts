import type { AgentRunOptions } from '../agent/types';
import type { Attention, TriageDecision } from '../inbox/types';
import type { WorkItem } from './types';
import type { SourceItem, SourceSeed, SourceTransition, AssessmentUpdate, AnalysisContext } from './lifecycle';
import type { WorkItemEvent } from './events';

export interface SourceContext {
  readonly items: readonly SourceItem[];
  readonly cursors: Record<string, number>;
  readonly seen: Record<string, number>;
  save(): Promise<void>;
  create(seed: SourceSeed, automatic: boolean): SourceItem;
  transition(item: SourceItem, event: SourceTransition): void;
  readonly closed: boolean;
  error?: string;
  observe(event: WorkItemEvent): Promise<WorkItem>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  blocked(): boolean;
  assertEnabled(): void;
  dispatch(): Promise<void>;
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
  beforeAnalysis?(item: SourceItem, signal: AbortSignal, current: () => boolean): Promise<boolean>;
  analysisContext?(item: SourceItem, input: SourceItem): AnalysisContext;
  assessment?: AssessmentPolicy;
}

/** Model screening and deterministic rules use the same decision lifecycle. */
export type AssessmentPolicy = ItemAssessmentPolicy | RuleAssessmentPolicy;
export interface RuleAssessmentPolicy {
  kind: 'rule';
  evaluate(event: WorkItemEvent): ItemDecision;
}
export interface ItemAssessmentPolicy {
  kind: 'item';
  failureReason?(error: unknown): string;
  available?: boolean;
  evaluate(item: WorkItem, signal: AbortSignal, progress: (text: string) => void): Promise<TriageDecision>;
  valid(input: WorkItem, decision: TriageDecision): boolean;
  interpret(input: SourceItem, decision: TriageDecision): AssessmentUpdate;
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
  canInvestigate?(): boolean;
  investigate(item: WorkItem, signal: AbortSignal): Promise<AnalysisResult>;
  checkAccess(): Promise<void>;
  cancel?(): void;
  cancelPending?(): void;
  deliver?(item: WorkItem, phase: 'pending' | 'progress' | 'result'): Promise<void>;
  beginAnalysis?(item: WorkItem, text: string): Promise<WorkItem['destination']>;
  notifyChange?(item: WorkItem, notice: NonNullable<WorkItem['sourceNotices']>[number]): Promise<WorkItem['destination']>;
  notifyAttention?(items: WorkItem[], id: string): Promise<void>;
}

export type ItemDecision = Pick<Attention, 'state' | 'reason' | 'priority'>;
