import type { AgentKind } from '../config/profile-schema';
import type { ModelSettings } from '../agent/model-settings';

export interface WorkflowDefinition {
  apiVersion: 'bridge.workflow/v1';
  id: string;
  version: string;
  kind: 'agent-led';
  mainInstructions: string;
  roles: Record<string, { instructions: string; outputKind: string }>;
  maxConcurrentWorkers: number;
  maxRevisionRounds: number;
  maxWallTimeMinutes: number;
}

/** The root native ID remains owned by SessionCatalog. Only its binding digest is pinned. */
export interface WorkflowRoot {
  scopeId: string;
  profile: string;
  agentKind: AgentKind;
  cwdRealpath: string;
  policyFingerprint: string;
  catalogBinding: string;
  modelSettings: ModelSettings;
}

export interface WorkerSession {
  sessionRef: string;
  actorId: string;
  actorKey: string;
  role: string;
  /** Absent only on instances persisted by older bridge builds. */
  execution?: WorkerExecution;
  nativeIdKind: 'sessionId' | 'threadId';
  nativeSessionId?: string;
  observedModel?: string;
  generation: number;
}

export interface WorkerExecutionSelection extends ModelSettings {
  agentKind: AgentKind;
}

export interface WorkerExecution {
  agentKind: AgentKind;
  profile: string;
  modelSettings: ModelSettings;
  policyFingerprint: string;
  configurationFingerprint: string;
}

export interface WorkflowTask {
  taskId: string;
  taskKey: string;
  requestDigest: string;
  sessionRef: string;
  objective: string;
  inputRefs: string[];
  status: 'queued' | 'starting' | 'running' | 'result_ready' | 'waiting_input' | 'failed' | 'cancelling' | 'cancelled' | 'interrupted';
  attempts: Array<{ attemptId: string; runId?: string; startedAt: number; endedAt?: number; result?: string }>;
  inputs: Array<{ inputId: string; text: string; receipt: string }>;
  resultRefs: string[];
  error?: string;
}

export interface WorkflowArtifact {
  ref: string;
  kind: string;
  text: string;
  digest: string;
  taskId?: string;
  attemptId?: string;
  createdAt: number;
}

export interface WorkflowEvent {
  id: string;
  kind: 'task_result_ready' | 'task_failed' | 'worker_question' | 'binding_attention' | 'budget_attention';
  taskId?: string;
  artifactRef?: string;
  summary: string;
  acknowledged: boolean;
  notified: boolean;
}

export interface WorkflowState {
  workflowId: string;
  root: WorkflowRoot;
  definition: WorkflowDefinition;
  definitionDigest: string;
  goal: string;
  stateVersion: number;
  revisionRound: number;
  status: 'active' | 'paused' | 'completed' | 'cancelled' | 'binding_attention' | 'interrupted';
  createdAt: number;
  deadlineAt: number;
  sessions: WorkerSession[];
  tasks: WorkflowTask[];
  artifacts: WorkflowArtifact[];
  events: WorkflowEvent[];
}

export type WorkflowCaller =
  | { scopeId: string; kind: 'main' }
  | { scopeId: string; kind: 'worker'; workflowId: string; taskId: string; attemptId: string };

export interface WorkflowWorkerRequest {
  workflow: WorkflowState;
  task: WorkflowTask;
  session: WorkerSession;
  attemptId: string;
  prompt: string;
  signal: AbortSignal;
  onSession(nativeId: string, model?: string): void;
  onRun(runId: string): void;
}

export interface WorkflowWorkerResult {
  status: 'completed' | 'failed' | 'stopped';
  text?: string;
  question?: string;
  error?: string;
}

export interface WorkflowHost {
  resolveRoot(scopeId: string): Promise<WorkflowRoot | undefined>;
  resolveWorker?(root: WorkflowRoot, selection: WorkerExecutionSelection): Promise<WorkerExecution>;
  execute(request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult>;
  wakeMain(scopeId: string): Promise<void>;
}
