import { boardTopics } from '../engine/board';
import type { WorkflowArchive } from '../engine/kernel-store';
import { BOARD_DEFAULT_TOPIC } from '../engine/limits';
import { queueControl, queueNames } from '../engine/work-routing';
import type {
  AgentTurn, BoardPost, DurableAgent, StoredArtifact, StoredTask, SwarmMember, WorkClaim, WorkflowState, WorkflowSwarm, WorkflowTask, WorkflowWorkItem,
} from '../engine/types';

/**
 * What a dashboard shows of a workflow, as plain JSON. These are projections of WorkflowState for people: names in
 * place of IDs, counts that include what was archived, long texts cut or left out until asked for. They hold no clock
 * readings other than timestamps, so a client renders durations itself and a view only changes when its workflow does.
 *
 * Nothing here reads a database or changes a workflow. The few lookups a projection needs beyond the state (archived
 * entries, stored texts) come in through ViewSource.
 */
export interface ViewSource {
  state: WorkflowState;
  archive: WorkflowArchive;
  text(digest: string): string;
}

export type Tone = 'running' | 'attention' | 'failed' | 'done' | 'cancelled';

export interface WorkflowSummary {
  id: string;
  rootId: string;
  parentId?: string;
  name: string;
  goal: string;
  status: WorkflowState['status'];
  /** What the status amounts to for someone watching: the script's state and the deadline are part of it. */
  stage: 'done' | 'cancelled' | 'binding' | 'paused' | 'interrupted' | 'script_failed' | 'summarizing' | 'queued' | 'running';
  tone: Tone;
  phase?: string;
  scope: string;
  profile: string;
  agent: string;
  model?: string;
  effort?: string;
  cwd: string;
  createdAt: number;
  deadlineAt: number;
  version: number;
  members: { total: number; running: number; stopped: number };
  /** `slot`: turns the host has not given an execution slot yet; they are not counted as running. */
  turns: { total: number; running: number; slot: number; waiting: number; queued: number; failed: number; done: number };
  work?: Record<WorkflowWorkItem['status'], number> & { total: number };
  todos: number;
  asks: number;
  notices: number;
}

export interface TodoView {
  id: number;
  kind: string;
  subject: string;
  since: number;
  /** Whoever holds it now; absent while the situation is younger than its grace time. */
  holder?: string;
  told: Array<{ who: string; at: number; by?: string; note?: string }>;
  goneAt?: number;
  deferred?: { by: string; at: number; until?: number; note?: string };
}

export interface QueueView {
  name: string;
  open: boolean;
  lead?: string;
  consumers: string[];
  /** Consumers that can still take work. */
  staffed: number;
  counts: Record<WorkflowWorkItem['status'], number>;
  held: number;
  /** Pending items that wait on another item or a gate. */
  blocked: number;
  dry?: { spells: number; ms: number; longest: number };
}

export interface SwarmView {
  key: string;
  status: WorkflowSwarm['status'];
  stop?: WorkflowSwarm['stop'];
  reason?: string;
  lead?: string;
  task: string;
  maxTurns: number;
  members: number;
  stopped: number;
  turns: number;
  /** Outcomes of work items that the lead has not been shown yet. */
  results: number;
  finish?: string;
}

export interface OverviewView {
  summary: WorkflowSummary;
  goal: string;
  charter?: { version: number; text: string; by: string; at: number };
  statuses: Array<{ lead: string; text: string; at: number; version: number }>;
  script?: { name: string; status: string; phase?: string; revision: number; calls: number; maxCalls: number; error?: string; logs: string[]; readOnly?: boolean;
    waits: Array<{ key: string; kinds: string[]; since: number }> };
  swarms: SwarmView[];
  queues: QueueView[];
  todos: TodoView[];
  asks: Array<{ seq: number; from: string; to: string; at: number; within: number; excerpt: string }>;
  notices: Array<{ id: string; kind: string; summary: string; createdAt?: number; notified: boolean; taskId?: string }>;
  slots: { waiting: number; totalMs: number; longestMs: number };
  mainWake?: { at: number; every?: number; note?: string };
  restart?: { since: number; resume: boolean };
  archived: { turns: number; records: Partial<Record<string, number>> };
}

/** What a member is doing; a client words and colours it. */
export type MemberPhase = 'running' | 'starting' | 'slot' | 'queued' | 'input' | 'child' | 'cancelling' | 'idle' | 'waiting' | 'ready'
  | 'failed' | 'retired' | 'done' | 'cancelled' | 'interrupted' | 'unknown' | 'unstarted';

export interface TurnBrief {
  taskId: string;
  key: string;
  member?: string;
  status: AgentTurn['status'];
  attempts: number;
  /** Timestamps of the latest attempt. */
  startedAt?: number;
  admittedAt?: number;
  endedAt?: number;
  retryAt?: number;
  error?: string;
  agent?: string;
  model?: string;
  effort?: string;
  workspace?: string;
  readOnly?: boolean;
}

export interface MemberView {
  name: string;
  agentId?: string;
  swarm?: string;
  role: 'lead' | 'queue-lead' | 'worker' | 'member' | 'agent';
  queue?: string;
  leads?: string[];
  under?: string;
  agent: string;
  model?: string;
  effort?: string;
  phase: MemberPhase;
  task?: TurnBrief;
  /** The work item the member holds a claim on. */
  item?: { key: string; title: string; leaseUntil: number };
  turns: number;
  maxTurns?: number;
  itemsDone: number;
  itemsFailed: number;
  sessions?: number;
  autoRevived?: number;
  unread: number;
  checkpoint?: { version: number; at: number };
  wakeAt?: number;
  wakeNote?: string;
  detail?: string;
  added?: boolean;
  workspace?: string;
  /** When the member's latest turn last started or ended. */
  activeAt?: number;
}

export interface MemberDetail extends MemberView {
  brief?: string;
  roleText?: string;
  takeover?: SwarmMember['takeover'];
  nativeSessionId?: string;
  recentTurns: TurnBrief[];
  messages: Array<{ id: string; from: string; at: number; text: string; topic?: string; post?: number }>;
  checkpointState?: string;
  claims: Array<{ item: string; title: string; status: WorkClaim['status']; createdAt: number; endedAt?: number; reason?: string }>;
}

export interface WorkItemView {
  id: string;
  key: string;
  title: string;
  queue: string;
  priority: number;
  status: WorkflowWorkItem['status'];
  hold?: boolean;
  heldReason?: string;
  gate?: boolean;
  by?: string;
  origin?: string;
  assignee?: string;
  doneBy?: string;
  owner?: string;
  generation: number;
  maxAttempts: number;
  failures?: number;
  progress: number;
  progressAt?: number;
  dependsOn?: string[];
  /** The items among dependsOn that are not completed. */
  waitsOn?: string[];
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  archived?: boolean;
}

export interface WorkView {
  version: number;
  queues: QueueView[];
  /** Items matching the filter, before paging. */
  total: number;
  items: WorkItemView[];
}

export interface WorkItemDetail extends WorkItemView {
  input: string;
  result?: string;
  progressState?: string;
  resources: string[];
  writes?: string[];
  supersedes?: string[];
  settledBy?: string;
  claims: Array<{ member: string; generation: number; status: WorkClaim['status']; createdAt: number; endedAt?: number; reason?: string; taskId: string }>;
}

export interface PostView {
  seq: number;
  from: string;
  to: string[];
  all?: boolean;
  topic?: string;
  text: string;
  truncated?: boolean;
  createdAt: number;
  /** The post asks for an answer; `open` while nobody has given one. */
  ask?: { within: number; open: boolean };
  answers?: number;
  resolved?: { by: string; at: number; note?: string; see?: number };
}

export interface BoardView {
  version: number;
  total: number;
  topics: Array<{ topic: string; posts: number; resolved?: number }>;
  posts: PostView[];
  /** Pass as `before` to read the posts older than these. */
  next?: number;
}

export interface TurnsView {
  version: number;
  total: number;
  archived: number;
  turns: TurnBrief[];
}

export interface TurnDetail extends TurnBrief {
  objective: string;
  attemptList: Array<{ attemptId: string; startedAt: number; admittedAt?: number; spawnedAt?: number; sessionAt?: number; endedAt?: number; result?: string;
    failureKind?: string; stopReason?: string }>;
  results: Array<{ ref: string; kind: string; text: string; truncated?: boolean; createdAt: number }>;
  nativeSessionId?: string;
  sessionRef: string;
  direct: Array<{ from: string; by?: string; at: number; text: string; delivery?: string }>;
  archived?: boolean;
}

const TERMINAL_ITEM = new Set<WorkflowWorkItem['status']>(['completed', 'cancelled']);
const RUNNING = new Set<AgentTurn['status']>(['running', 'starting', 'cancelling']);
const WAITING = new Set<AgentTurn['status']>(['waiting_input', 'waiting_workflow']);

/** Cuts a text for a list; whitespace runs collapse so one entry stays one line. */
function compact(value: unknown, limit: number): string {
  const text = (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

/** Cuts a text for a detail pane, keeping its line breaks. */
function clip(value: unknown, limit: number): { text: string; truncated?: boolean } {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text };
}

function names(state: WorkflowState): (agentId: string | undefined) => string {
  const byId = new Map((state.agents ?? []).map(agent => [agent.agentId, agent.key]));
  return agentId => agentId === undefined ? 'main' : byId.get(agentId) ?? agentId;
}

function stage(state: WorkflowState, now: number): Pick<WorkflowSummary, 'stage' | 'tone'> {
  if (state.status === 'completed') return { stage: 'done', tone: 'done' };
  if (state.status === 'cancelled') return { stage: 'cancelled', tone: 'cancelled' };
  if (state.status === 'binding_attention') return { stage: 'binding', tone: 'failed' };
  if (state.status === 'paused') return { stage: 'paused', tone: 'attention' };
  if (state.status === 'interrupted') return { stage: 'interrupted', tone: 'attention' };
  if (state.script?.status === 'failed') return { stage: 'script_failed', tone: 'failed' };
  if (state.script?.status === 'result_ready') return { stage: 'summarizing', tone: 'running' };
  if (state.script?.status === 'queued') return { stage: 'queued', tone: 'running' };
  return { stage: 'running', tone: now >= state.deadlineAt ? 'attention' : 'running' };
}

function workCounts(state: WorkflowState, queue?: string): Record<WorkflowWorkItem['status'], number> {
  const counts = { pending: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of state.workQueue?.items ?? []) if (queue === undefined || (item.queue ?? 'default') === queue) counts[item.status]++;
  for (const [name, archived] of Object.entries(state.workQueue?.archived ?? {})) {
    if (queue !== undefined && name !== queue) continue;
    for (const [status, count] of Object.entries(archived)) counts[status as WorkflowWorkItem['status']] += count ?? 0;
  }
  return counts;
}

export function summarize(state: WorkflowState, now: number): WorkflowSummary {
  const seats = (state.swarms ?? []).flatMap(swarm => swarm.members);
  const slot = (task: WorkflowTask) => task.status === 'starting' && !task.attempts.at(-1)?.admittedAt;
  const active = (task: WorkflowTask) => RUNNING.has(task.status) && !slot(task);
  const running = new Set(state.tasks.filter(task => active(task) && task.agentId).map(task => task.agentId));
  const count = (test: (task: WorkflowTask) => boolean) => state.tasks.filter(test).length;
  const work = state.workQueue && workCounts(state);
  const settings = state.root.modelSettings;
  return {
    id: state.workflowId, rootId: state.parent?.rootWorkflowId ?? state.workflowId, ...(state.parent ? { parentId: state.parent.workflowId } : {}),
    name: state.script?.name ?? state.definition.id, goal: compact(state.goal, 300), status: state.status, ...stage(state, now),
    ...(state.script?.phase ? { phase: compact(state.script.phase, 200) } : {}),
    scope: state.root.scopeId, profile: state.root.profile, agent: state.root.agentKind,
    ...(settings.model ? { model: settings.model } : {}), ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {}),
    cwd: state.root.cwdRealpath, createdAt: state.createdAt, deadlineAt: state.deadlineAt, version: state.stateVersion,
    members: { total: Math.max(state.agents?.length ?? 0, seats.length), running: running.size, stopped: seats.filter(seat => seat.stopped).length },
    turns: {
      total: state.tasks.length + (state.archived?.tasks ?? 0), running: count(active), slot: count(slot), waiting: count(task => WAITING.has(task.status)),
      queued: count(task => task.status === 'queued'), failed: count(task => task.status === 'failed') + (state.archived?.statuses.failed ?? 0),
      done: count(task => task.status === 'result_ready') + (state.archived?.statuses.result_ready ?? 0),
    },
    ...(work ? { work: { ...work, total: Object.values(work).reduce((sum, value) => sum + value, 0) } } : {}),
    todos: state.todos?.open.filter(todo => todo.goneAt === undefined).length ?? 0,
    asks: state.board?.asks?.length ?? 0,
    notices: state.events.filter(event => !event.acknowledged).length,
  };
}

function queueViews(state: WorkflowState): QueueView[] {
  if (!state.workQueue) return [];
  const items = state.workQueue.items;
  const done = new Map(items.map(item => [item.key, item.status === 'completed']));
  const seats = (state.swarms ?? []).flatMap(swarm => swarm.members.map(member => ({ swarm, member })));
  return queueNames(state).map(name => {
    const mine = items.filter(item => (item.queue ?? 'default') === name);
    const consumers = seats.filter(({ member }) => member.queue === name);
    const lead = seats.find(({ member }) => member.leads?.includes(name))?.member.name
      ?? seats.find(({ swarm, member }) => swarm.lead && member.queue === name)?.swarm.lead;
    const dry = (state.swarms ?? []).map(swarm => swarm.dry?.[name]).find(Boolean);
    return {
      name, open: queueControl(state, name)?.closedAt === undefined, ...(lead ? { lead } : {}),
      consumers: consumers.map(({ member }) => member.name), staffed: consumers.filter(({ member }) => !member.stopped).length,
      counts: workCounts(state, name), held: mine.filter(item => item.hold && !TERMINAL_ITEM.has(item.status)).length,
      blocked: mine.filter(item => item.status === 'pending' && item.dependsOn?.some(key => !done.get(key))).length,
      ...(dry ? { dry } : {}),
    };
  });
}

export function overview(state: WorkflowState, now: number): OverviewView {
  const name = names(state);
  const attempts = state.tasks.flatMap(task => task.attempts.map(attempt => ({ task, attempt })));
  const waiting = attempts.filter(({ task, attempt }) => task.status === 'starting' && task.attempts.at(-1) === attempt && !attempt.admittedAt);
  const waits = attempts.flatMap(({ attempt }) => attempt.admittedAt ? [attempt.admittedAt - attempt.startedAt] : []);
  const script = state.script;
  return {
    summary: summarize(state, now),
    goal: clip(state.goal, 40_000).text,
    ...(state.charter ? { charter: { version: state.charter.version, text: state.charter.text, by: state.charter.by, at: state.charter.at } } : {}),
    statuses: Object.entries(state.statuses ?? {}).map(([lead, status]) => ({ lead, ...status })),
    ...(script ? { script: {
      name: script.name, status: script.status, ...(script.phase ? { phase: script.phase } : {}), revision: script.revision,
      calls: script.calls.length + (script.archivedCalls ?? 0), maxCalls: script.maxCalls, ...(script.error ? { error: clip(script.error, 4000).text } : {}),
      logs: script.logs.slice(-40).map(line => clip(line, 2000).text), ...(script.readOnly ? { readOnly: true } : {}),
      waits: (state.waits ?? []).filter(wait => wait.runId === script.runId && wait.status === 'waiting')
        .map(wait => ({ key: wait.key, kinds: wait.any.map(arm => arm.kind), since: wait.createdAt })),
    } } : {}),
    swarms: (state.swarms ?? []).map(swarm => ({
      key: swarm.key, status: swarm.status, ...(swarm.stop ? { stop: swarm.stop } : {}), ...(swarm.reason ? { reason: compact(swarm.reason, 400) } : {}),
      ...(swarm.lead ? { lead: swarm.lead } : {}), task: clip(swarm.task, 6000).text, maxTurns: swarm.maxTurns, members: swarm.members.length,
      stopped: swarm.members.filter(member => member.stopped).length, turns: swarm.turns.length + (swarm.archivedTurns ?? 0), results: swarm.results?.length ?? 0,
      ...(swarm.finish ? { finish: clip(swarm.finish.result, 6000).text } : {}),
    })),
    queues: queueViews(state),
    todos: (state.todos?.open ?? []).map(todo => ({
      id: todo.id, kind: todo.kind, subject: todo.subject, since: todo.since, ...(todo.told.length ? { holder: todo.told.at(-1)!.who } : {}), told: todo.told,
      ...(todo.goneAt !== undefined ? { goneAt: todo.goneAt } : {}), ...(todo.deferred ? { deferred: todo.deferred } : {}),
    })),
    asks: (state.board?.asks ?? []).map(ask => ({ seq: ask.seq, from: name(ask.from), to: name(ask.to), at: ask.at, within: ask.within, excerpt: ask.excerpt })),
    notices: state.events.filter(event => !event.acknowledged).map(event => ({
      id: event.id, kind: event.kind, summary: compact(event.summary, 600), ...(event.createdAt ? { createdAt: event.createdAt } : {}), notified: event.notified,
      ...(event.taskId ? { taskId: event.taskId } : {}),
    })),
    slots: { waiting: waiting.length, totalMs: waits.reduce((sum, wait) => sum + wait, 0), longestMs: waits.length ? Math.max(...waits) : 0 },
    ...(state.mainWake ? { mainWake: state.mainWake } : {}),
    ...(state.restart ? { restart: state.restart } : {}),
    archived: { turns: state.archived?.tasks ?? 0, records: state.archivedRecords ?? {} },
  };
}

function turnBrief(state: WorkflowState, task: WorkflowTask | StoredTask, name: (agentId: string | undefined) => string,
  session = state.sessions.find(item => item.sessionRef === task.sessionRef)): TurnBrief {
  const attempt = task.attempts.at(-1);
  const settings = session?.execution?.modelSettings;
  const model = settings?.model ?? session?.observedModel;
  return {
    taskId: task.taskId, key: task.scriptKey ?? task.taskKey, ...(task.agentId ? { member: name(task.agentId) } : {}), status: task.status, attempts: task.attempts.length,
    ...(attempt ? { startedAt: attempt.startedAt } : {}), ...(attempt?.admittedAt ? { admittedAt: attempt.admittedAt } : {}), ...(attempt?.endedAt ? { endedAt: attempt.endedAt } : {}),
    ...(task.retryAt ? { retryAt: task.retryAt } : {}), ...(task.error ? { error: compact(task.error, 400) } : {}),
    agent: session?.execution?.agentKind ?? state.root.agentKind, ...(model ? { model } : {}), ...(settings?.reasoningEffort ? { effort: settings.reasoningEffort } : {}),
    ...(task.workspaceId ? { workspace: task.workspaceId } : {}), ...(task.readOnly ? { readOnly: true } : {}),
  };
}

function phaseOf(task: WorkflowTask): MemberPhase {
  switch (task.status) {
    case 'starting': return task.attempts.at(-1)?.admittedAt ? 'starting' : 'slot';
    case 'waiting_input': return 'input';
    case 'waiting_workflow': return 'child';
    case 'result_ready': return 'done';
    default: return task.status;
  }
}

/** Lookups a list of members shares, so that a swarm of hundreds is not searched once per member. */
interface MemberIndex {
  name(agentId: string | undefined): string;
  tasks: Map<string, WorkflowTask>;
  sessions: Map<string, WorkflowState['sessions'][number]>;
  unread: Map<string, number>;
  claims: Map<string, WorkClaim>;
  items: Map<string, WorkflowWorkItem>;
  checkpoints: Map<string, NonNullable<WorkflowState['checkpoints']>[number]>;
  receipts: Map<string, NonNullable<WorkflowState['mailbox']>['receipts'][number]>;
  turns: Map<string, number>;
}

function memberIndex(state: WorkflowState): MemberIndex {
  const unread = new Map<string, number>();
  for (const message of state.mailbox?.messages ?? []) if (!message.consumedByTurnId) unread.set(message.to, (unread.get(message.to) ?? 0) + 1);
  const turns = new Map<string, number>();
  for (const task of state.tasks) if (task.agentId) turns.set(task.agentId, (turns.get(task.agentId) ?? 0) + 1);
  return {
    name: names(state), unread, turns,
    tasks: new Map(state.tasks.map(task => [task.taskId, task])),
    sessions: new Map(state.sessions.map(session => [session.sessionRef, session])),
    // What a member handed to the landing queue is not what it is at work on.
    claims: new Map((state.workQueue?.claims ?? []).filter(claim => claim.status === 'active' && !claim.landing).map(claim => [claim.agentId, claim])),
    items: new Map((state.workQueue?.items ?? []).map(item => [item.id, item])),
    checkpoints: new Map((state.checkpoints ?? []).map(checkpoint => [checkpoint.ref, checkpoint])),
    receipts: new Map((state.mailbox?.receipts ?? []).map(receipt => [receipt.id, receipt])),
  };
}

function memberView(state: WorkflowState, seat: { swarm: WorkflowSwarm; member: SwarmMember } | undefined, agent: DurableAgent | undefined, index: MemberIndex): MemberView {
  const member = seat?.member;
  const task = agent && index.tasks.get(agent.activeTurnId ?? agent.lastTurnId ?? '');
  const session = agent && index.sessions.get(agent.sessionRef);
  const execution = member?.execution ?? session?.execution;
  const receipt = agent?.wait && index.receipts.get(agent.wait.receiptId);
  const phase: MemberPhase = agent?.activeTurnId && task ? phaseOf(task)
    : member?.stopped ? member.stopped
    : seat?.swarm.status === 'running' ? (agent ? 'idle' : 'unstarted')
    : agent?.wait?.kind === 'event' || receipt?.status === 'waiting' ? 'waiting'
    : receipt?.status === 'ready' ? 'ready'
    : task ? phaseOf(task) : 'unstarted';
  const claim = agent && index.claims.get(agent.agentId);
  const item = claim && index.items.get(claim.itemId);
  const checkpoint = agent?.checkpointRef ? index.checkpoints.get(agent.checkpointRef) : undefined;
  const attempt = task?.attempts.at(-1);
  const model = execution?.modelSettings.model ?? session?.observedModel;
  const key = member?.name ?? agent!.key;
  const workspace = member?.workspace ?? session?.workspaceId;
  return {
    name: key, ...(agent ? { agentId: agent.agentId } : {}), ...(seat ? { swarm: seat.swarm.key } : {}),
    role: !seat ? 'agent' : seat.swarm.lead === key ? 'lead' : member!.leads?.length ? 'queue-lead' : member!.queue ? 'worker' : 'member',
    ...(member?.queue ? { queue: member.queue } : {}), ...(member?.leads?.length ? { leads: member.leads } : {}), ...(member?.under ? { under: member.under } : {}),
    agent: execution?.agentKind ?? state.root.agentKind, ...(model ? { model } : {}),
    ...(execution?.modelSettings.reasoningEffort ? { effort: execution.modelSettings.reasoningEffort } : {}),
    phase, ...(task ? { task: turnBrief(state, task, index.name, session) } : {}),
    ...(item && claim ? { item: { key: item.key, title: compact(item.title, 200), leaseUntil: claim.heldUntil ?? claim.leaseUntil } } : {}),
    turns: member?.turns ?? (agent ? index.turns.get(agent.agentId) ?? 0 : 0), ...(seat ? { maxTurns: seat.swarm.maxTurns } : {}),
    itemsDone: member?.itemsDone ?? 0, itemsFailed: member?.itemsFailed ?? 0,
    ...(member?.sessions ? { sessions: member.sessions } : {}), ...(member?.autoRevived ? { autoRevived: member.autoRevived } : {}),
    unread: agent ? index.unread.get(agent.agentId) ?? 0 : 0,
    ...(checkpoint ? { checkpoint: { version: checkpoint.version, at: checkpoint.createdAt } } : {}),
    ...(member?.wakeAt ? { wakeAt: member.wakeAt } : {}), ...(member?.wakeNote ? { wakeNote: compact(member.wakeNote, 300) } : {}),
    ...(member?.detail ? { detail: compact(member.detail, 400) } : {}), ...(member?.added ? { added: true } : {}),
    ...(workspace ? { workspace } : {}),
    ...(attempt ? { activeAt: attempt.endedAt ?? attempt.startedAt } : {}),
  };
}

function seats(state: WorkflowState): Array<{ swarm: WorkflowSwarm; member: SwarmMember }> {
  return (state.swarms ?? []).flatMap(swarm => swarm.members.map(member => ({ swarm, member })));
}

/** Every member: those of the swarms in the order they were staffed, then the agents the script keeps on its own. */
export function members(state: WorkflowState): { version: number; members: MemberView[] } {
  const index = memberIndex(state);
  const agents = new Map((state.agents ?? []).map(agent => [agent.key, agent]));
  const seated = seats(state);
  const taken = new Set(seated.map(seat => seat.member.name));
  return { version: state.stateVersion, members: [
    ...seated.map(seat => memberView(state, seat, agents.get(seat.member.name), index)),
    ...(state.agents ?? []).filter(agent => !taken.has(agent.key)).map(agent => memberView(state, undefined, agent, index)),
  ] };
}

export function member({ state }: ViewSource, key: string): MemberDetail | undefined {
  const index = memberIndex(state);
  const name = index.name;
  const seat = seats(state).find(found => found.member.name === key);
  const agent = state.agents?.find(found => found.key === key);
  if (!seat && !agent) return undefined;
  const session = agent && index.sessions.get(agent.sessionRef);
  const checkpoint = agent?.checkpointRef ? index.checkpoints.get(agent.checkpointRef) : undefined;
  const items = index.items;
  return {
    ...memberView(state, seat, agent, index),
    ...(seat?.member.brief ? { brief: clip(seat.member.brief, 20_000).text } : {}), ...(seat?.member.role ? { roleText: clip(seat.member.role, 20_000).text } : {}),
    ...(seat?.member.takeover ? { takeover: seat.member.takeover } : {}), ...(session?.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
    recentTurns: agent ? state.tasks.filter(task => task.agentId === agent.agentId).slice(-30).reverse().map(task => turnBrief(state, task, name)) : [],
    messages: agent ? (state.mailbox?.messages ?? []).filter(message => message.to === agent.agentId && !message.consumedByTurnId).slice(-30).map(message => ({
      id: message.id, from: message.from === undefined ? 'main' : name(message.from), at: message.createdAt,
      text: clip(message.post !== undefined ? state.board?.posts.find(post => post.seq === message.post)?.text ?? message.text : message.text, 4000).text,
      ...(message.topic ? { topic: message.topic } : {}), ...(message.post !== undefined ? { post: message.post } : {}),
    })) : [],
    ...(checkpoint ? { checkpointState: clip(checkpoint.state, 20_000).text } : {}),
    claims: agent ? (state.workQueue?.claims ?? []).filter(claim => claim.agentId === agent.agentId).slice(-30).reverse().map(claim => ({
      item: items.get(claim.itemId)?.key ?? claim.itemId, title: compact(items.get(claim.itemId)?.title ?? '', 200), status: claim.status, createdAt: claim.createdAt,
      ...(claim.endedAt ? { endedAt: claim.endedAt } : {}), ...(claim.reason ? { reason: compact(claim.reason, 300) } : {}),
    })) : [],
  };
}

function itemView(state: WorkflowState, item: WorkflowWorkItem, name: (agentId: string | undefined) => string, done?: Map<string, boolean>): WorkItemView {
  const claim = item.claimId ? state.workQueue?.claims.find(found => found.id === item.claimId) : undefined;
  const waitsOn = done && item.status === 'pending' ? item.dependsOn?.filter(key => !done.get(key)) : undefined;
  return {
    id: item.id, key: item.key, title: compact(item.title, 300), queue: item.queue ?? 'default', priority: item.priority ?? 0, status: item.status,
    ...(item.hold ? { hold: true } : {}), ...(item.held?.reason ? { heldReason: compact(item.held.reason, 300) } : {}), ...(item.gate ? { gate: true } : {}),
    ...(item.by ? { by: item.by } : {}), ...(item.origin ? { origin: compact(item.origin, 200) } : {}), ...(item.assignee ? { assignee: item.assignee } : {}),
    ...(item.doneBy ? { doneBy: item.doneBy } : {}), ...(claim && item.status === 'claimed' ? { owner: name(claim.agentId) } : {}),
    generation: item.generation, maxAttempts: item.maxAttempts, ...(item.failures ? { failures: item.failures } : {}),
    progress: item.progress.version, ...(item.progress.updatedAt ? { progressAt: item.progress.updatedAt } : {}),
    ...(item.dependsOn?.length ? { dependsOn: item.dependsOn } : {}), ...(waitsOn?.length ? { waitsOn } : {}),
    ...(item.supersededBy ? { supersededBy: item.supersededBy } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt,
    ...(item.error ? { error: compact(item.error, 400) } : {}),
  };
}

const ITEM_ORDER: Record<WorkflowWorkItem['status'], number> = { claimed: 0, failed: 1, pending: 2, completed: 3, cancelled: 4 };

export interface WorkFilter {
  queue?: string;
  status?: string;
  /** Words that must all occur in the key, title, owner or origin. */
  query?: string;
  offset?: number;
  limit?: number;
  /** Also the items that left the state once they were finished, most recently archived first. */
  archived?: boolean;
}

export function work({ state, archive }: ViewSource, filter: WorkFilter = {}): WorkView {
  const name = names(state);
  const live = state.workQueue?.items ?? [];
  const done = new Map(live.map(item => [item.key, item.status === 'completed']));
  const terms = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = (view: WorkItemView) => (!filter.queue || view.queue === filter.queue) && (!filter.status || view.status === filter.status)
    && terms.every(term => [view.key, view.title, view.owner, view.origin, view.assignee, view.doneBy].some(field => field?.toLowerCase().includes(term)));
  const views = live.map(item => itemView(state, item, name, done)).filter(wanted)
    .sort((a, b) => ITEM_ORDER[a.status] - ITEM_ORDER[b.status] || b.priority - a.priority || b.updatedAt - a.updatedAt);
  if (filter.archived) {
    const stored = archive.search('workItem', terms.filter(term => !/["\\]/.test(term)), 300) as WorkflowWorkItem[];
    views.push(...stored.map(item => ({ ...itemView(state, item, name), archived: true })).filter(wanted));
  }
  const offset = Math.max(0, filter.offset ?? 0);
  return { version: state.stateVersion, queues: queueViews(state), total: views.length, items: views.slice(offset, offset + Math.min(500, Math.max(1, filter.limit ?? 200))) };
}

export function workItem({ state, archive }: ViewSource, key: string): WorkItemDetail | undefined {
  const name = names(state);
  const live = state.workQueue?.items ?? [];
  const found = live.find(item => item.key === key);
  const item = found ?? archive.record('workItem', { key }) as WorkflowWorkItem | undefined;
  if (!item) return undefined;
  const done = new Map(live.map(other => [other.key, other.status === 'completed']));
  return {
    ...itemView(state, item, name, found ? done : undefined), ...(found ? {} : { archived: true }),
    input: clip(item.input, 60_000).text, ...(item.result !== undefined ? { result: clip(item.result, 60_000).text } : {}),
    ...(item.progress.state !== undefined && item.progress.state !== null ? { progressState: clip(item.progress.state, 30_000).text } : {}),
    resources: item.resources, ...(item.writes?.length ? { writes: item.writes } : {}), ...(item.supersedes?.length ? { supersedes: item.supersedes } : {}),
    ...(item.settledBy ? { settledBy: item.settledBy } : {}), ...(item.error ? { error: clip(item.error, 8000).text } : {}),
    claims: (state.workQueue?.claims ?? []).filter(claim => claim.itemId === item.id).map(claim => ({
      member: name(claim.agentId), generation: claim.generation, status: claim.status, createdAt: claim.createdAt,
      ...(claim.endedAt ? { endedAt: claim.endedAt } : {}), ...(claim.reason ? { reason: compact(claim.reason, 400) } : {}), taskId: claim.taskId,
    })),
  };
}

export interface BoardFilter {
  topic?: string;
  /** Posts this member wrote or was sent. */
  member?: string;
  query?: string;
  /** Only posts with a seq below this one. */
  before?: number;
  limit?: number;
}

const POST_TEXT = 6000;

export function board({ state, archive }: ViewSource, filter: BoardFilter = {}): BoardView {
  const name = names(state);
  const live = state.board?.posts ?? [];
  const total = live.length + (state.archivedRecords?.post ?? 0);
  const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
  const agentId = filter.member ? state.agents?.find(agent => agent.key === filter.member)?.agentId ?? filter.member : undefined;
  const terms = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const open = new Set((state.board?.asks ?? []).map(ask => ask.seq));
  const wanted = (post: BoardPost) => (filter.topic === undefined || (post.topic ?? BOARD_DEFAULT_TOPIC) === filter.topic)
    && (agentId === undefined || post.from === agentId || post.to.includes(agentId))
    && terms.every(term => post.text.toLowerCase().includes(term));
  const posts: BoardPost[] = [];
  let before = filter.before ?? Number.MAX_SAFE_INTEGER;
  for (let index = live.length - 1; index >= 0 && posts.length < limit; index--) {
    const post = live[index]!;
    if (post.seq < before && wanted(post)) posts.push(post);
  }
  // Posts leave the state as a prefix of the feed, so everything older than the first one still in it is archived.
  before = Math.min(before, live[0]?.seq ?? Number.MAX_SAFE_INTEGER);
  let exhausted = !(state.archivedRecords?.post);
  while (posts.length < limit && !exhausted) {
    const page = archive.range('post', { after: 0, upTo: before - 1, limit: 200, desc: true }) as BoardPost[];
    exhausted = page.length < 200;
    for (const post of page) {
      before = post.seq;
      if (posts.length < limit && wanted(post)) posts.push(post);
      else if (posts.length >= limit) { exhausted = false; break; }
    }
  }
  const last = posts.at(-1)?.seq;
  return {
    version: state.stateVersion, total, topics: boardTopics(state).map(topic => ({ topic: topic.topic, posts: topic.posts, ...(topic.resolved ? { resolved: topic.resolved } : {}) })),
    posts: posts.map(post => {
      const { text, truncated } = clip(post.text, POST_TEXT);
      return {
        seq: post.seq, from: post.from ? name(post.from) : post.author ?? 'main', to: post.to.map(name), ...(post.all ? { all: true } : {}),
        ...(post.topic ? { topic: post.topic } : {}), text, ...(truncated ? { truncated } : {}), createdAt: post.createdAt,
        ...(post.ask ? { ask: { within: post.ask.within, open: open.has(post.seq) } } : {}), ...(post.answers ? { answers: post.answers } : {}),
        ...(post.resolved ? { resolved: { by: name(post.resolved.from), at: post.resolved.at, ...(post.resolved.note ? { note: post.resolved.note } : {}),
          ...(post.resolved.see ? { see: post.resolved.see } : {}) } } : {}),
      };
    }),
    ...(last !== undefined && last > 1 && (posts.length >= limit || !exhausted) ? { next: last } : {}),
  };
}

export interface TurnFilter {
  /** `active`: running, starting or waiting; `failed`; anything else lists every turn still in the state. */
  show?: string;
  member?: string;
  offset?: number;
  limit?: number;
}

export function turns(state: WorkflowState, filter: TurnFilter = {}): TurnsView {
  const name = names(state);
  const agentId = filter.member ? state.agents?.find(agent => agent.key === filter.member)?.agentId : undefined;
  const selected = state.tasks.filter(task => (!filter.member || task.agentId === agentId)
    && (filter.show === 'active' ? RUNNING.has(task.status) || WAITING.has(task.status) || task.status === 'queued'
      : filter.show === 'failed' ? ['failed', 'unknown', 'interrupted'].includes(task.status) : true));
  const latest = (task: WorkflowTask) => task.attempts.at(-1)?.startedAt ?? 0;
  selected.sort((a, b) => latest(b) - latest(a));
  const offset = Math.max(0, filter.offset ?? 0);
  return { version: state.stateVersion, total: selected.length, archived: state.archived?.tasks ?? 0,
    turns: selected.slice(offset, offset + Math.min(500, Math.max(1, filter.limit ?? 200))).map(task => turnBrief(state, task, name)) };
}

const TURN_TEXT = 120_000;

export function turn({ state, archive, text }: ViewSource, taskId: string): TurnDetail | undefined {
  const name = names(state);
  const live = state.tasks.find(task => task.taskId === taskId);
  const stored = live ? undefined : archive.task(taskId) as StoredTask | undefined;
  const task = live ?? stored;
  if (!task) return undefined;
  const session = state.sessions.find(item => item.sessionRef === task.sessionRef);
  const artifact = (ref: string) => {
    const found = state.artifacts.find(item => item.ref === ref);
    if (found) return { ...clip(found.text, TURN_TEXT), ref, kind: found.kind, createdAt: found.createdAt, ...(found.truncated ? { truncated: true } : {}) };
    const old = archive.artifact(ref) as StoredArtifact | undefined;
    return old ? { ...clip(text(old.digest), TURN_TEXT), ref, kind: old.kind, createdAt: old.createdAt, ...(old.truncated ? { truncated: true } : {}) } : undefined;
  };
  return {
    ...turnBrief(state, task, name), ...(stored ? { archived: true } : {}),
    objective: clip(live ? live.objective : text(stored!.objective.digest), TURN_TEXT).text,
    attemptList: task.attempts.map(attempt => ({
      attemptId: attempt.attemptId, startedAt: attempt.startedAt, ...(attempt.admittedAt ? { admittedAt: attempt.admittedAt } : {}),
      ...(attempt.spawnedAt ? { spawnedAt: attempt.spawnedAt } : {}), ...(attempt.sessionAt ? { sessionAt: attempt.sessionAt } : {}),
      ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}), ...(attempt.result ? { result: attempt.result } : {}),
      ...(attempt.failureKind ? { failureKind: attempt.failureKind } : {}), ...(attempt.stopReason ? { stopReason: attempt.stopReason } : {}),
    })),
    results: task.resultRefs.flatMap(ref => artifact(ref) ?? []),
    ...(task.error ? { error: clip(task.error, 8000).text } : {}),
    ...(session?.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}), sessionRef: task.sessionRef,
    direct: (state.direct ?? []).filter(message => message.taskId === taskId).map(message => ({
      from: message.from, ...(message.by ? { by: message.by } : {}), at: message.createdAt, text: clip(message.text, 8000).text,
      ...(message.delivery ? { delivery: message.delivery } : {}),
    })),
  };
}

/** The plan the script was started with, and its source. */
export function plan({ state, archive, text }: ViewSource): { plan?: string; source?: string; args?: string } | undefined {
  const script = state.script;
  if (!script) return undefined;
  const read = (ref: string | undefined) => {
    if (!ref) return undefined;
    const found = state.artifacts.find(item => item.ref === ref);
    if (found) return found.text;
    const old = archive.artifact(ref) as StoredArtifact | undefined;
    return old && text(old.digest);
  };
  const args = script.args === undefined || script.args === null ? undefined : clip(script.args, 20_000).text;
  return { plan: read(script.planRef), source: read(script.sourceRef), ...(args ? { args } : {}) };
}
