import type { AgentKind } from '../config/profile-schema';
import type { ModelSettings } from '../agent/model-settings';

export interface WorkflowDefinition {
  apiVersion: 'bridge.workflow/v1';
  id: string;
  version: string;
  kind: 'script-led';
  mainInstructions: string;
  roles: Record<string, { instructions: string; outputKind: string }>;
  maxConcurrentWorkers: number;
  maxRevisionRounds: number;
  maxWallTimeMinutes: number;
  /** Persisted with the workflow; older workflows used a 30-minute default. */
  defaultWallTimeMinutes?: number;
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

export interface SessionBinding {
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

export type WorkerSession = SessionBinding;

export interface DurableAgent {
  agentId: string;
  key: string;
  sessionRef: string;
  checkpointVersion: number;
  checkpointRef?: string;
  lastTurnId?: string;
  activeTurnId?: string;
  wait?: WaitState;
}

export interface AgentCheckpoint {
  ref: string;
  agentId: string;
  version: number;
  turnId: string;
  attemptId?: string;
  sessionGeneration: number;
  nativeSessionId?: string;
  state: unknown;
  resultRef?: string;
  createdAt: number;
}

export interface TurnAttempt {
  attemptId: string;
  runId?: string;
  startedAt: number;
  endedAt?: number;
  result?: string;
  checkpointVersion?: number;
  sessionGeneration?: number;
}

export interface WaitState {
  kind: 'message';
  receiptId: string;
}

export interface MailboxMessage {
  id: string;
  to: string;
  from?: string;
  text: string;
  createdAt: number;
  receiptId?: string;
  consumedByTurnId?: string;
}

export interface MailboxReceipt {
  id: string;
  key: string;
  digest: string;
  agentId: string;
  status: 'waiting' | 'ready' | 'consumed';
  messageIds: string[];
  turnId?: string;
}

export interface AgentMailbox {
  messages: MailboxMessage[];
  receipts: MailboxReceipt[];
  operations: Array<{ key: string; digest: string; response: unknown }>;
}

/** Work and progress survive replacement of the member that claims them. */
export interface WorkflowWorkItem {
  id: string;
  key: string;
  digest: string;
  title: string;
  input: unknown;
  resources: string[];
  maxAttempts: number;
  generation: number;
  status: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
  claimId?: string;
  progress: { version: number; state: unknown; updatedAt?: number };
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkClaim {
  id: string;
  itemId: string;
  agentId: string;
  taskId: string;
  attemptId: string;
  generation: number;
  leaseUntil: number;
  status: 'active' | 'completed' | 'failed' | 'released' | 'expired' | 'cancelled';
  createdAt: number;
  endedAt?: number;
  reason?: string;
}

export interface WorkflowWorkQueue {
  items: WorkflowWorkItem[];
  claims: WorkClaim[];
  operations: Array<{ key: string; digest: string; response: unknown }>;
  closedAt?: number;
  closeKey?: string;
}

/** One script-owned consumer pool per workflow; waiting never holds a worker process. */
export interface WorkConsumerPool {
  id: string;
  key: string;
  digest: string;
  runId: string;
  prompt: string;
  maxTurns: number;
  status: 'waiting' | 'running' | 'drained' | 'failed' | 'suspended' | 'cancelled';
  reason?: string;
  members: Array<{
    name: string;
    execution: WorkerExecution;
    workflowTool?: boolean;
    taskId?: string;
    lastWake?: string;
    retryPending?: boolean;
    disabled?: string;
  }>;
  turns: Array<{ key: string; member: string; taskId: string }>;
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

export interface AgentTurn {
  taskId: string;
  taskKey: string;
  requestDigest: string;
  sessionRef: string;
  objective: string;
  inputRefs: string[];
  status: 'queued' | 'starting' | 'running' | 'result_ready' | 'waiting_input' | 'waiting_workflow' | 'failed' | 'cancelling' | 'cancelled' | 'interrupted';
  attempts: TurnAttempt[];
  resultRefs: string[];
  error?: string;
  scriptRunId?: string;
  scriptKey?: string;
  scriptOutput?: 'text' | 'json';
  cacheKey?: string;
  agentId?: string;
  previousTurnId?: string;
  inputCheckpointVersion?: number;
  inputMessageIds?: string[];
  workflowTool?: boolean;
  waitingWorkflowId?: string;
  resumeWorkflowId?: string;
  yieldRequestedAt?: number;
}

export interface WorkflowParent {
  workflowId: string;
  taskId: string;
  rootWorkflowId: string;
  depth: number;
  key: string;
  digest: string;
  operationId: string;
  parentQueue: boolean;
  checkpoint: unknown;
}

export type WorkflowTask = AgentTurn;

export interface WorkflowScript {
  name: string;
  sourceRef: string;
  planRef?: string;
  args: unknown;
  defaults: WorkerExecutionSelection;
  runId: string;
  revision: number;
  status: 'queued' | 'running' | 'paused' | 'result_ready' | 'failed' | 'interrupted' | 'cancelled';
  maxCalls: number;
  calls: Array<{ key: string; taskId: string; cached: boolean }>;
  mailboxCalls?: string[];
  workCalls?: string[];
  logs: string[];
  phase?: string;
  resultRef?: string;
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
  kind: 'binding_attention' | 'budget_attention' | 'script_result_ready' | 'script_failed';
  taskId?: string;
  artifactRef?: string;
  summary: string;
  acknowledged: boolean;
  notified: boolean;
}

export interface WorkflowState {
  workflowId: string;
  parent?: WorkflowParent;
  root: WorkflowRoot;
  definition: WorkflowDefinition;
  definitionDigest: string;
  goal: string;
  stateVersion: number;
  status: 'active' | 'paused' | 'completed' | 'cancelled' | 'binding_attention' | 'interrupted';
  createdAt: number;
  deadlineAt: number;
  sessions: WorkerSession[];
  tasks: WorkflowTask[];
  artifacts: WorkflowArtifact[];
  events: WorkflowEvent[];
  agents?: DurableAgent[];
  checkpoints?: AgentCheckpoint[];
  mailbox?: AgentMailbox;
  workQueue?: WorkflowWorkQueue;
  consumerPool?: WorkConsumerPool;
  script?: WorkflowScript;
}

export type WorkflowCaller =
  | { scopeId: string; kind: 'main'; allowStart?: boolean; workflowId?: string }
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
  getTimeoutMinutes?(root: WorkflowRoot): number;
  resolveWorker?(root: WorkflowRoot, selection: WorkerExecutionSelection): Promise<WorkerExecution>;
  execute(request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult>;
  wakeMain(scopeId: string): Promise<void>;
}
