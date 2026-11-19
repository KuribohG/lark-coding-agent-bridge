/**
 * The lists of a workflow's state, other than its tasks, whose old entries move to the archive. An entry is archived
 * only once nothing will change it again; from then on it is read by its ID or key (see archivedRecord).
 */
export type RecordKind = 'post' | 'message' | 'receipt' | 'mailboxOperation' | 'workItem' | 'claim' | 'workOperation' | 'wait'
  | 'controlOperation' | 'workspaceKey' | 'notice' | 'direct' | 'mailboxCall' | 'workCall' | 'controlCall' | 'workspaceCall';

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
  authorizationExpiresAt?: number;
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
  /** Posts the board held when the member's latest turn was scheduled. */
  boardSeq?: number;
  /** The charter version in force when the member's latest turn was scheduled. */
  charterSeen?: number;
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
  executionId?: string;
  logicalCallId?: string;
  completionDigest?: string;
  completedRevision?: number;
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
  /** Why the attempt ended, when the reason is one the engine can act on (see `failureKind`). */
  failureKind?: string;
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
  /** Set on the delivery of a board post to one of its recipients: the post's seq. The text lives on the post. */
  post?: number;
}
/** Who wrote a board post when it was not a member. */
export type BoardAuthor = 'main' | 'script' | 'system';
/**
 * Why a post no longer needs anybody's attention: its question was answered, its request done, its conclusion
 * replaced. The post stays in the feed as written; readers skip it unless they ask for resolved posts.
 */
export interface PostResolution {
  /** The agentId of the member that resolved it; absent for the main agent. */
  from?: string;
  at: number;
  /** What settled it, in a sentence. */
  note?: string;
  /** The seq of the post that answers or replaces this one. */
  see?: number;
}
/**
 * One entry of the workflow's shared, append-only message board. Posts are never edited or removed; the only thing
 * that changes about one is whether it is resolved.
 */
export interface BoardPost {
  /** Position in the feed, starting at 1. */
  seq: number;
  id: string;
  /** The posting member's agentId; absent for the main agent and the script. */
  from?: string;
  author?: BoardAuthor;
  /** agentIds of the members the post was delivered to. */
  to: string[];
  /** The post addressed everyone (`all`), whatever the membership was at the time. */
  all?: boolean;
  /** The workstream the post belongs to; absent for the default topic. */
  topic?: string;
  text: string;
  createdAt: number;
  resolved?: PostResolution;
}
export interface SwarmMember {
  name: string;
  role?: string;
  execution: WorkerExecution;
  workflowTool?: boolean;
  workspace?: string;
  /** Its managed worktree was cleaned up after the member was retired; it cannot be revived. */
  cleaned?: boolean;
  /** Added by the lead while the swarm was running, with the brief it gave. */
  added?: boolean;
  brief?: string;
  /** The member's latest turn. */
  taskId?: string;
  /** The work queue this member consumes: it is also woken whenever that queue has work it could claim. */
  queue?: string;
  /**
   * The work queues this member leads under the swarm's lead: it plans their part of the task instead of consuming
   * them, is handed the results of their items, and is told when one runs dry or one of its members fails.
   */
  leads?: string[];
  /** The available work the member was last woken for; the same set does not wake it twice. */
  lastWake?: string;
  /** Wake-ups used after the opening turn. */
  turns: number;
  /** Its unfinished turn is retried under the same key when the script is replayed. */
  retryPending?: boolean;
  stopped?: 'failed' | 'retired';
  detail?: string;
  /** Times the engine put the member back to work after a failed turn, without anyone asking. */
  autoRevived?: number;
  /** A wake-up the member asked for with wake_me: when it is due and what it is for. Cleared by the turn it starts. */
  wakeAt?: number;
  wakeNote?: string;
  /** Work items the member completed, and the ones its claim left failed for good. */
  itemsDone?: number;
  itemsFailed?: number;
}
/**
 * A group of persistent members that coordinate on the board. The kernel schedules their turns: every member runs
 * once, then again whenever a post names it. An optional lead may add and retire members and decides when to finish;
 * under it, members that lead queues plan those parts of the work.
 */
export interface WorkflowSwarm {
  id: string;
  key: string;
  digest: string;
  runId: string;
  task: string;
  lead?: string;
  maxTurns: number;
  status: 'running' | 'done';
  stop?: 'finished' | 'quiet' | 'max_turns' | 'failed';
  reason?: string;
  /** Board seq of the swarm's brief, and of the last post when it ended. */
  firstPost: number;
  lastPost?: number;
  /** Reminders sent to the lead while everyone was idle, since a member other than the lead last ran. */
  nudges: number;
  /** The reminders went unanswered and the main agent has been told; cleared when a turn starts. */
  stalled?: boolean;
  finish?: { result: string };
  /**
   * Queues whose consumers are idle with nothing to claim: since when, and when the lead and the main agent were last
   * told. An entry leaves when the queue has work to claim again or all its consumers are busy.
   */
  starved?: Record<string, { since: number; leadAt?: number; mainAt?: number }>;
  /** What the starved spells of each queue that are over add up to: how many there were, and how long they lasted. */
  dry?: Record<string, { spells: number; ms: number; longest: number }>;
  /**
   * Work items that were completed or failed for good under a member's claim and whose outcome no lead has been given
   * yet, oldest first; a swarm without a lead keeps none. They are gathered and handed to the lead that planned each
   * of them when its next turn is scheduled.
   */
  handoffs?: Array<{ item: string; worker: string }>;
  members: SwarmMember[];
  /** Turns whose task is still in the state, oldest first; `archivedTurns` counts the completed ones that left it. */
  turns: Array<{ key: string; member: string; taskId: string }>;
  archivedTurns?: number;
}
/**
 * The goal as it stands now. The workflow's goal and a swarm's task are fixed when they start; the charter is what the
 * main agent or a lead replaces when the direction changes, and every worker turn is given the version in force.
 */
export interface WorkflowCharter {
  version: number;
  text: string;
  /** `main`, or the name of the lead that set it. */
  by: string;
  at: number;
}
/** A wake-up of the main agent it asked for with wake_me: due at `at`, and again every `every` ms when recurring. */
export interface MainWake {
  at: number;
  every?: number;
  note?: string;
}
export interface WorkflowBoard {
  posts: BoardPost[];
  /**
   * By topic: the posts made in it and the seq of its latest few, oldest first. It covers the posts that have left
   * the state as well. Posts made before topics existed are not counted here; they belong to the default topic.
   * `resolved` is how many of the topic's posts are resolved now.
   */
  topics?: Record<string, { posts: number; recent: number[]; resolved?: number }>;
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
  | { kind: 'timer'; afterMs: number }
  /** Every listed member is parked in an unsettled wait with no turn running and nothing that wait could receive. */
  | { kind: 'quiet'; members: string[] };

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
  /** The member that added the item; absent for items from the script or the main agent. */
  by?: string;
  input: unknown;
  resources: string[];
  /**
   * The paths the item expects to change. Unlike `resources` they lock nothing: unfinished items whose paths overlap
   * and that nothing orders are reported to whoever adds, reads or claims one of them.
   */
  writes?: string[];
  maxAttempts: number;
  generation: number;
  status: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
  /** Set aside by whoever plans the queue: the item keeps its place but is not handed out until the hold is lifted. */
  hold?: boolean;
  claimId?: string;
  progress: { version: number; state: unknown; updatedAt?: number };
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkClaim {
  frozen?: boolean;
  /**
   * A host restart cut short the turn that holds this claim. Until its member's next attempt adopts the claim, or
   * this time passes, the claim keeps its item, cannot be used, and does not expire by lease.
   */
  heldUntil?: number;
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
  /** Archived items of each queue by their final status. */
  archived?: Record<string, Partial<Record<WorkflowWorkItem['status'], number>>>;
  closedAt?: number;
  closeKey?: string;
  queues?: Record<string, { closedAt?: number; closeKey?: string }>;
  /**
   * What entered and left each queue in every ten-minute slot of the last hours, oldest first: items added, completed
   * and failed for good. `slot` counts ten-minute spans since the epoch.
   */
  flow?: Record<string, WorkFlowSlot[]>;
}

export interface WorkFlowSlot {
  slot: number;
  enqueued?: number;
  completed?: number;
  failed?: number;
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
  status: 'queued' | 'starting' | 'running' | 'result_ready' | 'waiting_input' | 'waiting_workflow' | 'failed' | 'cancelling' | 'cancelled' | 'interrupted' | 'unknown';
  quiescence?: 'requested' | 'quiescent' | 'unknown';
  attempts: TurnAttempt[];
  /** Earliest time the next attempt may start; set when a failed attempt is retried. */
  retryAt?: number;
  /** Retries already granted to this task; retries do not consume the task budget. */
  retryCount?: number;
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
  /** Member turns: posts the board held when the member's previous turn was scheduled; later ones are new to this turn. */
  boardSince?: number;
  /** Member turns: the charter version in force when the member's previous turn was scheduled; a later one is new to this turn. */
  charterSince?: number;
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
  /** Local engine termination cause; model output never supplies this field. */
  stopReason?: WorkflowStopReason;
  name: string;
  sourceRef: string;
  planRef?: string;
  args: unknown;
  defaults: WorkerExecutionSelection;
  runId: string;
  revision: number;
  status: 'queued' | 'running' | 'paused' | 'result_ready' | 'failed' | 'interrupted' | 'cancelled';
  maxCalls: number;
  /** Agent calls of this run whose task is still in the state; `archivedCalls` counts the ones whose task was archived. */
  calls: Array<{ key: string; taskId: string; cached: boolean }>;
  archivedCalls?: number;
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
  /** The worker's answer was longer than the artifact limit and was cut; the tail is lost. */
  truncated?: boolean;
  taskId?: string;
  attemptId?: string;
  createdAt: number;
}

export interface WorkflowEvent {
  id: string;
  kind: 'binding_attention' | 'budget_attention' | 'script_result_ready' | 'script_failed' | 'worker_reply' | 'worker_input_required' | 'swarm_stalled' | 'swarm_attention' | 'landing_attention' | 'review_due';
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

/** `inactive`: no turn is running; `unsupported`: the worker's harness cannot take input mid-turn; `unknown`: sent, acknowledgement lost. */
export type WorkerInputStatus = 'accepted' | 'inactive' | 'unsupported' | 'unknown';

/** One message of the conversation between the main agent and a running worker turn. */
export interface DirectMessage {
  id: string;
  taskId: string;
  from: 'main' | 'worker' | 'lead';
  /** The lead that sent it, for a message from a lead. */
  by?: string;
  text: string;
  createdAt: number;
  /** For a message into the worker's turn: whether its transport acknowledged it. */
  delivery?: 'accepted' | 'unknown';
}

/** What has left a workflow's state for the archive (see archive.ts), so that totals stay exact. */
export interface WorkflowArchiveTotals {
  tasks: number;
  attempts: number;
  statuses: Partial<Record<AgentTurn['status'], number>>;
}

export interface WorkflowState {
  workflowId: string;
  parent?: WorkflowParent;
  root: WorkflowRoot;
  definition: WorkflowDefinition;
  definitionDigest: string;
  goal: string;
  stateVersion: number;
  status: 'active' | 'paused' | 'completed' | 'cancelled' | 'binding_attention' | 'interrupted' | 'cancelling';
  createdAt: number;
  deadlineAt: number;
  sessions: WorkerSession[];
  /** Unfinished and recently finished tasks; older finished ones are archived and counted in `archived`. */
  tasks: WorkflowTask[];
  artifacts: WorkflowArtifact[];
  archived?: WorkflowArchiveTotals;
  /** Entries of each other list that have left the state for the archive (see records.ts). */
  archivedRecords?: Partial<Record<RecordKind, number>>;
  events: WorkflowEvent[];
  agents?: DurableAgent[];
  checkpoints?: AgentCheckpoint[];
  mailbox?: AgentMailbox;
  board?: WorkflowBoard;
  charter?: WorkflowCharter;
  mainWake?: MainWake;
  direct?: DirectMessage[];
  swarms?: WorkflowSwarm[];
  workQueue?: WorkflowWorkQueue;
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

export type WorkflowCaller =
  | { scopeId: string; kind: 'main'; allowStart?: boolean; workflowId?: string }
  | { scopeId: string; kind: 'worker'; workflowId: string; taskId: string; attemptId: string };

export interface WorkflowWorkerRequest {
  executionId: string;
  logicalCallId: string;
  /** The workflow the turn belongs to. Only what a host needs for the whole turn; read the rest through the kernel. */
  workflow: Pick<WorkflowState, 'workflowId' | 'root' | 'deadlineAt'>;
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
  confirmedNotSubmitted?: boolean;
  stopReason?: WorkflowStopReason;
  status: 'completed' | 'failed' | 'stopped' | 'unknown';
  quiescence?: 'requested' | 'quiescent' | 'unknown';
  text?: string;
  question?: string;
  error?: string;
}

export interface WorkflowHost extends WorkerExecutionPolicy {
  executionLedger?: ExecutionLedgerPort;
  /** Workers call the workflow through a host tool, so prompts must not name the shell CLI. */
  hostTools?: boolean;
  log?: WorkflowLogger;
  /** Silence after which a running worker with no tool in flight is treated as hung. Defaults to 15 minutes. */
  stallMs?: number;
  /**
   * Silence after which a running worker is treated as hung although a tool is in flight, for tools the host reports
   * no due time for. Defaults to 7 hours; 0 leaves such a worker alone.
   */
  toolStallMs?: number;
  /** Backoff before each retry of a failed attempt, in order (last repeats). Defaults to 30 s, 2 min, 5 min. */
  retryDelaysMs?: readonly number[];
  resolveRoot(scopeId: string): Promise<WorkflowRoot | undefined>;
  getTimeoutMinutes?(root: WorkflowRoot): number;
  resolveWorker?(root: WorkflowRoot, selection: WorkerExecutionSelection): Promise<WorkerExecution>;
  resolveWorkspace?(root: WorkflowRoot, workflowId: string, workspaceId: string): Promise<void>;
  workspace?(state: WorkflowState, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** Lands the commits of the worktree `taskId` runs in; resolves to a LandReport (workspace-types.ts). */
  /** Delivers text to the worker turn of `taskId` while it runs, as a user message in its session. */
  tell?(workflowId: string, taskId: string, text: string, messageId: string): Promise<WorkerInputStatus>;
  land?(state: WorkflowState, input: { workspace: string; taskId: string }, signal: AbortSignal): Promise<unknown>;
  /** Reports the landing and applies the main agent's changes to it; resolves to a LandingChange (workspace-types.ts). */
  landing?(state: WorkflowState, input: Record<string, unknown>): Promise<unknown>;
  execute(request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult>;
  wakeMain(scopeId: string): Promise<void>;
}

export type ExecutionObservation =
  | { state: 'not-submitted'; proof: string }
  | { state: 'completed'; result: WorkflowWorkerResult; nativeSessionId?: string }
  | { state: 'unknown'; reason?: string };
export interface ExecutionLedgerPort {
  /** The workflow scope lets a host read only the records that execution can belong to. */
  lookupExecution(executionId: string, scopeId: string): Promise<ExecutionObservation>;
}
