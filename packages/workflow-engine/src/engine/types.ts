/** Harness names are host-defined; the engine treats them as opaque strings. */
export type AgentKind = string;

export interface ModelSettings {
  model?: string;
  reasoningEffort?: string;
}

export type WorkflowStopReason = 'cancelled' | 'deadline' | 'idle' | 'shutdown' | 'yield' | 'input' | 'cleanup';

export type NativeIdKind = 'sessionId' | 'threadId';

export interface WorkflowLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** Host-specific execution rules layered over the engine's structural checks. */
export interface WorkerExecutionPolicy {
  /** Validates harness/model/effort names; throws on unsupported values. */
  checkSelection?(selection: WorkerExecutionSelection): void;
  nativeIdKind?(agentKind: AgentKind): NativeIdKind;
  /** Repairs JSON syntax in `output: "json"` answers after strict parsing and fence extraction fail; throws when unrepairable. */
  repairJson?(text: string): unknown;
}

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
  nativeIdKind: NativeIdKind;
  nativeSessionId?: string;
  observedModel?: string;
  generation: number;
  workspaceId?: string;
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
  stopReason?: WorkflowStopReason;
  attemptId: string;
  runId?: string;
  /** Attempt queued by the kernel; host admission may still be pending. */
  startedAt: number;
  /** Host granted an execution slot; the gap from startedAt is queueing outside the engine. */
  admittedAt?: number;
  /** Native worker process started. */
  spawnedAt?: number;
  /** Worker reported its native session, the first sign the agent is running. */
  sessionAt?: number;
  endedAt?: number;
  result?: string;
  checkpointVersion?: number;
  sessionGeneration?: number;
}

export interface WaitState {
  kind: 'message' | 'event';
  receiptId: string;
}

export interface MailboxMessage {
  id: string;
  to: string;
  from?: string;
  text: string;
  topic?: string;
  correlationId?: string;
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
  match?: { topic?: string; correlationId?: string };
}

export type WorkflowWaitSelector =
  | { kind: 'message'; member: string; topic?: string; correlationId?: string }
  | { kind: 'work'; itemId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'timer'; afterMs: number };

export interface WorkflowWait {
  id: string;
  key: string;
  digest: string;
  runId: string;
  any: WorkflowWaitSelector[];
  createdAt: number;
  status: 'waiting' | 'ready';
  result?: { index: number; kind: WorkflowWaitSelector['kind']; value: unknown };
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
  queue?: string;
  priority?: number;
  dependsOn?: string[];
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
  queues?: Record<string, { closedAt?: number; closeKey?: string }>;
}

/** Script-owned consumers; waiting never holds a worker process. */
export interface WorkConsumerPool {
  id: string;
  key: string;
  digest: string;
  runId: string;
  prompt: string;
  maxTurns: number;
  queue?: string;
  maxConcurrent?: number;
  wakeOnMessages?: boolean;
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
  /** JSON Schema the parsed answer must satisfy. */
  scriptSchema?: Record<string, unknown>;
  cacheKey?: string;
  agentId?: string;
  previousTurnId?: string;
  inputCheckpointVersion?: number;
  inputMessageIds?: string[];
  workflowTool?: boolean;
  waitingWorkflowId?: string;
  resumeWorkflowId?: string;
  yieldRequestedAt?: number;
  scriptManaged?: boolean;
  scriptCancelled?: boolean;
  consumerMessageTurn?: boolean;
  workspaceId?: string;
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
  controlCalls?: string[];
  workspaceCalls?: string[];
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
  /** Absent on events recorded before timing was tracked. */
  createdAt?: number;
  notifiedAt?: number;
  acknowledgedAt?: number;
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
  /** Additional pools; the original field keeps persisted single-pool workflows readable. */
  consumerPools?: WorkConsumerPool[];
  waits?: WorkflowWait[];
  controlOperations?: Array<{ key: string; digest: string; taskId: string }>;
  workspaceKeys?: string[];
  script?: WorkflowScript;
  /** Set when a bridge restart interrupted the workflow: when the outage began and whether it was running and may resume automatically. */
  restart?: { since: number; resume: boolean };
}

/** Large text kept out of the in-memory state: stored once under its digest and read on demand. */
export interface TextRef {
  digest: string;
  chars: number;
}

/**
 * The kernel's own shape of a workflow. It differs from the public WorkflowState only in keeping artifact texts and
 * task prompts by reference; the kernel resolves them when it hands a state to a host.
 */
export type StoredArtifact = Omit<WorkflowArtifact, 'text'> & { chars: number };
export type StoredTask = Omit<AgentTurn, 'objective'> & { objective: TextRef };
export type WorkflowData = Omit<WorkflowState, 'tasks' | 'artifacts'> & { tasks: StoredTask[]; artifacts: StoredArtifact[] };

export type Immutable<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer U)[] ? readonly Immutable<U>[]
    : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

/** Live kernel state as everything but the event reducers sees it: changes go through events (see events.ts). */
export type WorkflowView = Immutable<WorkflowData>;
export type TaskView = Immutable<StoredTask>;
export type ArtifactView = Immutable<StoredArtifact>;
export type AgentView = Immutable<DurableAgent>;
export type PoolView = Immutable<WorkConsumerPool>;

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
  /** The host granted an execution slot; call before admission checks run. */
  onAdmitted(): void;
}

export interface WorkflowWorkerResult {
  stopReason?: WorkflowStopReason;
  status: 'completed' | 'failed' | 'stopped';
  text?: string;
  question?: string;
  error?: string;
}

export interface WorkflowHost extends WorkerExecutionPolicy {
  log?: WorkflowLogger;
  resolveRoot(scopeId: string): Promise<WorkflowRoot | undefined>;
  getTimeoutMinutes?(root: WorkflowRoot): number;
  resolveWorker?(root: WorkflowRoot, selection: WorkerExecutionSelection): Promise<WorkerExecution>;
  resolveWorkspace?(root: WorkflowRoot, workflowId: string, workspaceId: string): Promise<void>;
  workspace?(state: WorkflowState, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  execute(request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult>;
  wakeMain(scopeId: string): Promise<void>;
}
