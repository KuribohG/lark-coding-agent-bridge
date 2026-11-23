import { randomUUID } from 'node:crypto';
import { postToBoard, readBoard } from './board';
import { workflowDigest } from './digest';
import { boardTotal, callCount, readArtifact, taskById } from './kernel-state';
import { emit } from './kernel-store';
import type { KernelContext } from './kernel-context';
import { BOARD_ANNOUNCE_TOPIC, MAX_CONCURRENT_WORKERS, SWARM_DECLARED_MEMBERS, SWARM_MAX_LIVE_MEMBERS, SWARM_MAX_MEMBERS, SWARM_MAX_TURNS, WAKE_MAX_MINUTES } from './limits';
import { workerSelection } from './execution';
import { boundedInteger, parseScriptAgentCall, scriptText } from './script-contract';
import { openQueue, queueStanding, unfinishedWork, workFlow, workStatus, type WorkAuthority } from './work-queue';
import { MEMBER_NAME, queueControl, queueName } from './work-routing';
import type { Immutable, SwarmMember, WorkerExecution, WorkerExecutionPolicy, WorkerExecutionSelection, WorkflowSwarm, WorkflowTask, WorkflowView, WorkflowWorkItem } from './types';

/**
 * A swarm: members that work on one task for as long as it takes. There are two parts to play. A lead turns the goal
 * into work items, judges what comes back and deals with what waits on it: the lead of the swarm for the whole, the
 * lead of a queue for the work of that queue. Everyone else does the work of one queue. Above a member stand the lead
 * of its queue, the leads that one answers to, the lead of the swarm and the main agent, in that order (`leadsAbove`):
 * a lead names the lead it answers to (`under`), so the leads form a tree of whatever depth the work needs.
 *
 * This file holds who the members are and how the staff changes. When members are woken and what waits on whom is in
 * swarm-pump.ts, and what a member is told in swarm-brief.ts.
 */

export const MEMBER_BUSY = new Set<WorkflowTask['status']>(['queued', 'starting', 'running', 'cancelling', 'waiting_workflow']);
const BUSY = MEMBER_BUSY;
const RESERVED = ['all', 'main', 'script', 'system'];
export type SwarmView = Immutable<WorkflowSwarm>;
export type MemberView = Immutable<SwarmMember>;
export type ItemView = Immutable<WorkflowWorkItem>;

/**
 * A member that plans and judges instead of taking the work: the swarm's lead, and a member that leads queues under
 * it. Such a member runs for as long as the swarm does, so `maxTurns` does not bound it and its turns are not what
 * tells an idle swarm from a working one.
 */
export const coordinates = (swarm: SwarmView, member: MemberView) => member.name === swarm.lead || Boolean(member.leads?.length);

/** Whether the member plans work for others: it is the lead of its swarm or leads queues in it. This does not change while the member lives. */
export function plansWork(state: WorkflowView, name: string | undefined): boolean {
  const swarm = ownerOf(state, name);
  return Boolean(swarm && coordinates(swarm, swarm.members.find(member => member.name === name)!));
}

/** The member a queue's own work is planned by, while that member runs. */
export const queueLead = (swarm: SwarmView, queue: string) => swarm.members.find(member => !member.stopped && member.leads?.includes(queue));

/** Who answers for a queue: its own lead while there is one, the swarm's lead otherwise. */
export const answersFor = (swarm: SwarmView, queue: string | undefined) => (queue ? queueLead(swarm, queue) : undefined) ?? swarm.members.find(member => member.name === swarm.lead);

export const quoted = (names: readonly string[]) => names.map(name => `"${name}"`).join(', ');

/**
 * A system post in a topic of its own that must not undo the change it reports. It quotes names and members' text,
 * so an @name in it names nobody. A board that is out of topics takes the post without one; a board that cannot take
 * it at all goes without it.
 */
function systemPost(state: WorkflowView, input: { text: string; to?: string[]; topic: string }, now: number): void {
  for (const topic of [input.topic, undefined]) {
    try { postToBoard(state, { author: 'system' }, { ...input, topic }, now, { literal: true }); return; } catch {}
  }
}

function memberName(value: unknown): string {
  const name = scriptText(value, 'swarm member name', 100);
  if (!MEMBER_NAME.test(name) || RESERVED.includes(name)) throw new Error('Swarm member names use 1–40 letters, digits, _, . or -, and cannot be all, main, script or system');
  return name;
}

function role(value: unknown): string | undefined {
  return value === undefined ? undefined : scriptText(value, 'swarm member role', 2000);
}

/** The queues a member is to lead, as `leads` names them: one queue or a list. */
function ledQueues(value: unknown): string[] {
  const names = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(names) || !names.length || names.length > 16 || names.some(name => typeof name !== 'string')) throw new Error('leads is a queue name or an array of 1–16 queue names');
  return [...new Set(names.map(name => queueName(name)))].sort();
}

interface SpecMember { name: string; role?: string; selection: ReturnType<typeof parseScriptAgentCall>['selection']; workflowTool?: true; workspace?: string; queue?: string; leads?: string[]; under?: string }

export function parseSwarm(input: Record<string, unknown>, state: WorkflowView, policy?: WorkerExecutionPolicy) {
  if (Object.keys(input).some(key => !['key', 'task', 'lead', 'members', 'maxTurns'].includes(key))) throw new Error('swarm supports key, lead, members and maxTurns only');
  const key = scriptText(input.key, 'swarm key', 80);
  if (key.trim() !== key || key.startsWith('@')) throw new Error('swarm key must not contain surrounding whitespace or start with @');
  const task = scriptText(input.task, 'swarm task', 16_000);
  if (!task.trim()) throw new Error('swarm needs a task');
  const maxTurns = boundedInteger(input.maxTurns, 6, 1, SWARM_MAX_TURNS);
  if (!Array.isArray(input.members) || !input.members.length) throw new Error('swarm needs members');
  const listed = [...(input.lead === undefined ? [] : [input.lead]), ...input.members];
  if (listed.length > SWARM_DECLARED_MEMBERS) throw new Error(`swarm needs 1–${SWARM_DECLARED_MEMBERS} members, the lead included`);
  const members = listed.map((value: unknown): SpecMember => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid swarm member');
    const { name, role: description, ...options } = value as Record<string, unknown>;
    if (Object.keys(options).some(option => !['harness', 'model', 'reasoningEffort', 'workflowTool', 'workspace', 'queue', 'leads', 'under'].includes(option))) throw new Error('Unsupported swarm member option');
    const { queue, leads, under, ...execution } = options;
    const call = parseScriptAgentCall({ ...execution, key, member: memberName(name), prompt: task }, state.script!.defaults, state.root, policy);
    return { name: call.member!, role: role(description), selection: call.selection, ...(call.workflowTool ? { workflowTool: true } : {}), ...(call.workspace ? { workspace: call.workspace } : {}), ...(queue !== undefined ? { queue: queueName(queue) } : {}),
      ...(leads !== undefined ? { leads: ledQueues(leads) } : {}), ...(under !== undefined ? { under: memberName(under) } : {}) };
  });
  if (new Set(members.map(member => member.name)).size !== members.length) throw new Error('Swarm member names must be unique');
  const lead = input.lead === undefined ? undefined : members[0]!;
  if (lead?.queue) throw new Error('The lead plans the work and judges what comes back; it does not consume a queue');
  // A lead hands out work as items of a queue and in no other way, so every member it plans for consumes one. Without
  // a lead, a member that names no queue works on the task itself, side by side with the others.
  if (lead) for (const member of members) if (member !== lead && !member.leads && !member.queue) member.queue = 'default';
  const led = members.flatMap(member => member.leads ?? []);
  if (led.length) {
    // A queue's lead plans one part of the work; whether the whole is done stays one member's call.
    if (input.lead === undefined) throw new Error('Members that lead queues need a swarm lead, which they report to and which decides when the swarm is done');
    if (members[0]!.leads) throw new Error('The swarm lead answers for every queue without its own lead; leads is for other members');
    if (members.some(member => member.leads && member.queue)) throw new Error('A member that leads queues plans their work and does not consume a queue');
    if (new Set(led).size !== led.length) throw new Error('A queue has one lead');
  }
  for (const member of members) {
    if (member.under === undefined) continue;
    // Leads form a tree under the swarm's lead: each names the lead it answers to, and nobody answers to itself.
    if (!member.leads) throw new Error('under names the lead a lead answers to; a member that consumes a queue answers to the lead of that queue');
    const seen = new Set<string>();
    for (let at: SpecMember | undefined = member; at?.under !== undefined; at = members.find(other => other.name === at!.under)) {
      if (seen.has(at.name)) throw new Error(`Leads cannot answer to each other in a circle: ${[...seen].join(', ')}`);
      seen.add(at.name);
      const above = members.find(other => other.name === at!.under);
      if (!above?.leads || above === lead) throw new Error(`under names another member that leads queues; "${at.under}" is not one (a lead answers to the swarm lead when it names none)`);
    }
  }
  return { key, task, maxTurns, members, ...(input.lead === undefined ? {} : { lead: members[0]!.name }) };
}

function ownerOf(state: WorkflowView, name: string | undefined): SwarmView | undefined {
  return state.swarms?.find(swarm => swarm.members.some(member => member.name === name));
}

/** The swarm a member belongs to; its turns are scheduled by the kernel, not by script calls. */
export const memberSwarm = ownerOf;

/**
 * The lead a lead answers to: the one it names (`under`) while that one runs, else the one that one answers to, and
 * in the end the lead of the swarm. Undefined for the lead of the swarm, which answers to the main agent.
 */
export function superior(swarm: SwarmView, member: MemberView): MemberView | undefined {
  if (member.name === swarm.lead) return undefined;
  const seen = new Set([member.name]);
  for (let name = member.under; name !== undefined && !seen.has(name);) {
    seen.add(name);
    const found = swarm.members.find(item => item.name === name);
    if (!found) break;
    if (!found.stopped) return found;
    name = found.under;
  }
  const head = swarm.members.find(item => item.name === swarm.lead && !item.stopped);
  return head && head !== member ? head : undefined;
}

/** The leads above a member, the nearest first: the lead of its queue, then each lead's own, up to the lead of the swarm. */
export function chainAbove(swarm: SwarmView, member: MemberView): MemberView[] {
  const above: MemberView[] = [];
  let next = member.queue ? answersFor(swarm, member.queue) : coordinates(swarm, member) ? superior(swarm, member) : undefined;
  while (next && next !== member && !next.stopped && !above.includes(next)) { above.push(next); next = superior(swarm, next); }
  return above;
}

/**
 * The members that stand above a member while its swarm runs, the nearest first. Empty for the lead of a swarm, in a
 * swarm without one, and for a member of no swarm: above those there is only the main agent.
 */
export function leadsAbove(state: WorkflowView, name: string): string[] {
  const swarm = ownerOf(state, name);
  if (!swarm || swarm.status !== 'running' || swarm.finish) return [];
  return chainAbove(swarm, swarm.members.find(member => member.name === name)!).map(member => member.name);
}

/** Whether a member plans the work of a queue: it leads the swarm or the queue, or the queue's lead answers to it. */
export function plansQueue(swarm: SwarmView, member: MemberView, queue: string): boolean {
  if (member.name === swarm.lead || member.leads?.includes(queue)) return true;
  const own = queueLead(swarm, queue);
  return Boolean(own && member.leads?.length && chainAbove(swarm, own).includes(member));
}

/**
 * Whether a member can still take a turn, so that something can wait on it: it belongs to a running swarm of this run
 * that is not finishing and has not stopped. A member the script runs itself has a turn whenever the script gives it one.
 */
export function takesTurns(state: WorkflowView, name: string): boolean {
  if (state.status !== 'active' || state.script?.status !== 'running') return false;
  const swarm = ownerOf(state, name);
  if (!swarm) return Boolean(state.agents?.some(agent => agent.key === name));
  return swarm.status === 'running' && swarm.runId === state.script.runId && !swarm.finish && !swarm.members.find(item => item.name === name)!.stopped;
}

function nameTaken(state: WorkflowView, name: string): boolean {
  return Boolean(state.agents?.some(agent => agent.key === name) || ownerOf(state, name));
}

/**
 * Refuses members a swarm cannot take. The live count is what the run can actually staff, so retired and failed
 * members do not block replacements; the lifetime count keeps the member records in the state bounded.
 */
export function assertRoomFor(swarm: Pick<SwarmView, 'members'>, names: readonly string[]): void {
  const live = swarm.members.filter(member => !member.stopped).length;
  if (live + names.length > SWARM_MAX_LIVE_MEMBERS) {
    throw new Error(`A swarm runs at most ${SWARM_MAX_LIVE_MEMBERS} live members; retire members, clean their worktrees, or revive fewer before adding more`);
  }
  if (swarm.members.length + names.length > SWARM_MAX_MEMBERS) {
    throw new Error(`A swarm holds at most ${SWARM_MAX_MEMBERS} members over its life, retired and failed ones included`);
  }
}

/** Called after resolving every member's authorized execution binding. Creates the swarm, or rejoins it on replay. */
export function bindSwarm(state: WorkflowView, spec: ReturnType<typeof parseSwarm>, executions: WorkerExecution[], now: number): void {
  const digest = workflowDigest({ spec, executions });
  const runId = state.script!.runId;
  let swarm = state.swarms?.find(item => item.key === spec.key);
  if (swarm) {
    if (swarm.digest !== digest) throw new Error('Swarm definition changed; its key, task and member bindings are immutable across replay');
    if (swarm.runId === runId) throw new Error('Duplicate swarm call');
  } else {
    if ((state.swarms?.length ?? 0) >= 8) throw new Error('Swarm limit reached');
    if (spec.members.some(member => nameTaken(state, member.name))) throw new Error('Swarm requires dedicated member names not already used in this workflow');
    for (const member of spec.members) for (const name of [...(member.queue ? [member.queue] : []), ...member.leads ?? []]) openQueue(state, name);
    const brief = postToBoard(state, { author: 'script' }, { text: `Swarm "${spec.key}" task:\n` + (spec.task.length > 3800 ? spec.task.slice(0, 3800) + '…[truncated]' : spec.task) }, now);
    const created: WorkflowSwarm = { id: randomUUID(), key: spec.key, digest, runId, task: spec.task, maxTurns: spec.maxTurns, status: 'running',
      firstPost: brief.seq, turns: [], ...(spec.lead ? { lead: spec.lead } : {}),
      members: spec.members.map((member, index) => ({ name: member.name, execution: executions[index]!, turns: 0,
        ...(member.role !== undefined ? { role: member.role } : {}), ...(member.workflowTool ? { workflowTool: true } : {}), ...(member.workspace ? { workspace: member.workspace } : {}), ...(member.queue ? { queue: member.queue } : {}),
        ...(member.leads ? { leads: member.leads } : {}), ...(member.under ? { under: member.under } : {}) })) };
    emit(state, { type: 'swarm_created', swarm: created });
    return;
  }
  // Rebuild each member's committed turn chain without running its completed turns again.
  const completed = swarm.turns.filter(turn => taskById(state, turn.taskId)?.status === 'result_ready');
  // Archived turns all completed; they count as calls of this run without being listed in it.
  const archivedCalls = swarm.archivedTurns ?? 0;
  if (callCount(state) + completed.length + archivedCalls > state.script!.maxCalls) throw new Error('Script agent call limit reached');
  for (const turn of completed) emit(state, { type: 'script_call_recorded', call: { key: turn.key, taskId: turn.taskId, cached: true } });
  // A swarm that failed is what an explicit replay is for: it runs again from its records. Its failed members
  // retry their turn like the ones a pause cut short, and the queues the script closed once the swarm had returned
  // take new work again. A swarm that finished or went quiet keeps its result.
  const reopened = swarm.status === 'done' && swarm.stop === 'failed' && !swarm.finish;
  if (reopened) {
    for (const member of swarm.members) if (member.stopped === 'failed') emit(state, { type: 'swarm_member_revived', swarmId: swarm.id, member: member.name });
    for (const name of new Set(swarm.members.flatMap(member => member.queue ? [member.queue] : []))) {
      if (queueControl(state, name)?.closedAt !== undefined) emit(state, { type: 'work_queue_reopened', name });
    }
  }
  const retryPending = swarm.members.filter(member => !member.stopped && member.taskId && taskById(state, member.taskId)?.status !== 'result_ready').map(member => member.name);
  emit(state, { type: 'swarm_rebound', swarmId: swarm.id, runId, retryPending, ...(archivedCalls ? { archivedCalls } : {}), ...(reopened ? { reopened } : {}) });
}

/** Turns the swarm has scheduled, archived ones included. */
export function turnCount(swarm: SwarmView): number {
  return swarm.turns.length + (swarm.archivedTurns ?? 0);
}

/** The lead of a running swarm, for the management operations only it may call. */
function leadSwarm(state: WorkflowView, caller: string): SwarmView {
  const swarm = ownerOf(state, caller);
  if (!swarm || swarm.lead !== caller) throw new Error('Only the lead of a swarm can manage it');
  if (swarm.status !== 'running' || swarm.runId !== state.script?.runId) throw new Error('Swarm is no longer running');
  if (swarm.finish) throw new Error('Swarm is already finishing');
  return swarm;
}

function runningSwarm(state: WorkflowView, key: unknown): SwarmView {
  const running = (state.swarms ?? []).filter(swarm => swarm.status === 'running' && swarm.runId === state.script?.runId && !swarm.finish);
  const swarm = key === undefined ? (running.length === 1 ? running[0] : undefined) : running.find(item => item.key === scriptText(key, 'swarm key', 80));
  if (!swarm) throw new Error(key === undefined ? `Name the swarm: ${running.map(item => item.key).join(', ') || 'none is running'}` : 'No running swarm has this key');
  return swarm;
}

const EXECUTION_OPTIONS = ['harness', 'model', 'reasoningEffort'];

/** The member whose binding, role and queue new members take over: the first that does the work, unless one is named. */
function likeMember(swarm: SwarmView, like: unknown): MemberView {
  const found = like === undefined ? swarm.members.find(member => !coordinates(swarm, member)) ?? swarm.members[0]! : swarm.members.find(member => member.name === like);
  if (!found) throw new Error('like must name an existing member of this swarm');
  return found;
}

/**
 * The harness and model `staff_swarm` asks for when it does not bind its new members like an existing one; undefined
 * when it does. What is not named comes from the `like` member, except that another harness does not inherit a model.
 * The host resolves the selection to an execution binding before `staffSwarm` runs.
 */
export function staffSelection(state: WorkflowView, input: Record<string, unknown>, policy?: WorkerExecutionPolicy): WorkerExecutionSelection | undefined {
  if (!EXECUTION_OPTIONS.some(option => input[option] !== undefined)) return undefined;
  if (input.add === undefined) throw new Error('harness, model and reasoningEffort bind the members that add names');
  const { execution } = likeMember(runningSwarm(state, input.swarm), input.like);
  const harness = input.harness ?? execution.agentKind;
  const { model, reasoningEffort } = harness === execution.agentKind ? execution.modelSettings : {} as WorkerExecution['modelSettings'];
  return workerSelection({ agentKind: harness, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}), ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}) }, state.root, policy);
}

/**
 * The worktrees `staff_swarm` makes for the members it adds, one per name; undefined when it asks for none. A member
 * that is added without one runs in the workflow's own checkout, where editing code races the main agent and the
 * other members, and cannot submit work through a landing branch. Creation is the host operation behind the script's
 * `createWorkspace`, keyed by swarm and member, so a retried call reuses the worktree it already made; `staffSwarm`
 * binds the IDs in the change that adds the members.
 */
export async function staffWorkspaces(ctx: KernelContext, state: WorkflowView, input: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  if (input.workspace === undefined || input.workspace === false) return undefined;
  if (input.add === undefined) throw new Error('workspace binds the members that add names');
  if (!ctx.host.workspace) throw new Error('Workspace creation is unavailable in this workflow');
  if (state.parent) throw new Error('Workspace operations are unavailable in this workflow');
  if (state.status !== 'active' || state.script?.status !== 'running') throw new Error('Workflow is inactive');
  const options = input.workspace === true ? {} : input.workspace;
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['base', 'repo', 'isolation'].includes(key))) throw new Error('workspace is true or an object with base, repo and isolation');
  const swarm = runningSwarm(state, input.swarm);
  const like = likeMember(swarm, input.like);
  if (like.workflowTool) throw new Error('Workspace v1 does not support nested workflow delegation');
  if (!Array.isArray(input.add) || !input.add.length || input.add.length > 256) throw new Error('add is an array of 1–256 new member names');
  const names = input.add.map(memberName);
  if (new Set(names).size !== names.length) throw new Error('Member names must be unique');
  assertRoomFor(swarm, names);
  const taken = names.find(name => nameTaken(state, name));
  if (taken) throw new Error('Member name is already used in this workflow: ' + taken);
  // Validate what the change will re-check, so a rejected staffing call does not leave worktrees behind.
  if (input.queue !== undefined) queueName(input.queue);
  if (input.leads !== undefined && (ledQueues(input.leads), names.length !== 1)) throw new Error('leads makes one member the lead of its queues; add that member alone');
  if (input.role !== undefined) role(input.role);
  if (input.brief !== undefined) scriptText(input.brief, 'member brief', 4000);
  if (input.maxTurns !== undefined) {
    const maxTurns = boundedInteger(input.maxTurns, swarm.maxTurns, 1, SWARM_MAX_TURNS);
    if (maxTurns < swarm.maxTurns) throw new Error(`maxTurns can only be raised; it is ${swarm.maxTurns}`);
  }
  if (input.maxConcurrent !== undefined) boundedInteger(input.maxConcurrent, state.definition.maxConcurrentWorkers, 1, MAX_CONCURRENT_WORKERS);
  const signal = new AbortController().signal;
  // One view for the whole staffing call: every member's worktree is created against the same state snapshot.
  const view = ctx.store.workspaceView(state);
  const made = await Promise.all(names.map(async name => {
    const created = await ctx.host.workspace!(view, { kind: 'create', key: `staff/${swarm.id}/${name}`, ...options }, signal) as { id?: unknown };
    if (typeof created?.id !== 'string') throw new Error('Workspace creation did not return an ID');
    return [name, created.id] as const;
  }));
  return Object.fromEntries(made);
}

/** The members a cleanup names: those it lists, or every retired member that still holds a worktree. */
function cleanupNames(swarm: SwarmView, value: unknown): string[] {
  const names = value === 'retired'
    ? swarm.members.filter(member => member.stopped === 'retired' && member.workspace && !member.cleaned).map(member => member.name)
    : Array.isArray(value) ? value.map(name => scriptText(name, 'member name', 100)) : undefined;
  if (!names) throw new Error('cleanup is "retired" or an array of member names');
  if (names.length > 256) throw new Error('cleanup names at most 256 members');
  if (new Set(names).size !== names.length) throw new Error('Member names must be unique');
  return names;
}

/** The members whose worktrees a cleanup may release; already-cleaned ones are left out. */
function pendingCleanup(swarm: SwarmView, names: string[]): Array<{ name: string; workspace: string }> {
  return names.flatMap(name => {
    const member = swarm.members.find(item => item.name === name);
    if (!member) throw new Error('Unknown swarm member: ' + name);
    if (member.cleaned) return [];
    if (!member.stopped) throw new Error(`Member ${name} is still running; retire it before cleaning its worktree`);
    if (!member.workspace) throw new Error(`Member ${name} has no managed worktree`);
    return [{ name, workspace: member.workspace }];
  });
}

/**
 * Releases the worktrees of retired or failed members, one per name, so a long-running swarm does not keep every
 * directory it ever made against the workflow's workspace budget. Cleanup is the host operation behind the script's
 * `cleanupWorkspace`: it removes an idle worktree together with any uncommitted or unintegrated work in it, since a
 * member that cannot be revived is usually better redone than kept for work nobody may ever land. The members the
 * script removed with its own key are reported as removed again rather than failing. `staffSwarm` records the
 * release in the change that marks the members cleaned.
 */
export async function staffCleanups(ctx: KernelContext, state: WorkflowView, input: Record<string, unknown>): Promise<Array<{ name: string; workspace: string }> | undefined> {
  if (input.cleanup === undefined) return undefined;
  if (!ctx.host.workspace) throw new Error('Workspace cleanup is unavailable in this workflow');
  if (state.parent) throw new Error('Workspace operations are unavailable in this workflow');
  if (state.status !== 'active' || state.script?.status !== 'running') throw new Error('Workflow is inactive');
  const latest = ctx.store.state(state.root.scopeId, state.workflowId) ?? state;
  const swarm = runningSwarm(latest, input.swarm);
  const pending = pendingCleanup(swarm, cleanupNames(swarm, input.cleanup));
  if (!pending.length) return [];
  const signal = new AbortController().signal;
  const view = ctx.store.workspaceView(latest);
  await Promise.all(pending.map(item => ctx.host.workspace!(view,
    { kind: 'cleanup', key: `staff/cleanup/${swarm.id}/${item.name}`, workspace: item.workspace }, signal)));
  return pending;
}

/**
 * Changes to the staff of a running swarm, by the main agent or by the swarm's lead, so that staffing can follow
 * the work without a replay: more members, more wake-ups, failed members put back to work, members retired.
 * A new member runs with the execution binding of an existing one, or with `execution`: the binding the host resolved
 * for the harness and model the main agent named (see `staffSelection`), and in a worktree the host made for it
 * (see `staffWorkspaces`), so code written in parallel stays isolated. A lead cannot name harnesses or models, so a
 * member never reaches those beyond what the script and the main agent chose. Whether a queue gets a lead of its own
 * is likewise the main agent's decision: `leads` makes the one member it adds the lead of those queues.
 */
export function staffSwarm(state: WorkflowView, input: Record<string, unknown>, lead?: string, execution?: WorkerExecution, workspaces?: Record<string, string>, cleanedUp?: Array<{ name: string; workspace: string }>, now = Date.now()): unknown {
  if (Object.keys(input).some(key => !['swarm', 'add', 'like', 'workspace', 'queue', 'leads', 'under', 'role', 'brief', 'move', 'revive', 'retire', 'cleanup', 'maxTurns', 'maxConcurrent', ...EXECUTION_OPTIONS].includes(key))) throw new Error('staff_swarm supports swarm, add, like, workspace, harness, model, reasoningEffort, queue, leads, under, role, brief, move, revive, retire, cleanup, maxTurns and maxConcurrent');
  const workspaceWanted = input.workspace !== undefined && input.workspace !== false;
  if (workspaceWanted && state.script?.readOnly) throw new Error('Workspace operations are disabled in read-only workflows');
  if (workspaceWanted && input.add === undefined) throw new Error('workspace binds the members that add names');
  if (input.leads !== undefined && lead !== undefined) throw new Error('Only the main agent can give a queue a lead of its own');
  if (input.leads !== undefined && input.add === undefined) throw new Error('leads binds the member that add names');
  if (input.under !== undefined && input.leads === undefined) throw new Error('under names the lead a new lead answers to; give it with leads');
  const chosen = EXECUTION_OPTIONS.some(option => input[option] !== undefined);
  if (chosen && lead !== undefined) throw new Error('Only the main agent can choose the harness or model of new members; a lead adds members like an existing one');
  if (chosen && !execution) throw new Error('The harness and model of the new members were not resolved');
  const swarm = lead === undefined ? runningSwarm(state, input.swarm) : leadSwarm(state, lead);
  if (input.add === undefined && input.move === undefined && input.revive === undefined && input.retire === undefined && input.cleanup === undefined && input.maxTurns === undefined && input.maxConcurrent === undefined) throw new Error('staff_swarm needs add, move, revive, retire, cleanup, maxTurns or maxConcurrent');
  const result: { swarm: string; added?: string[]; leads?: string[]; moved?: string[]; unconsumed?: string[]; revived?: string[]; retired?: string[]; cleaned?: string[]; maxTurns?: number; maxConcurrent?: number; execution?: WorkerExecutionSelection; workspaces?: Array<{ name: string; workspace: string }> } = { swarm: swarm.key };
  if (input.maxConcurrent !== undefined) {
    // How many workers run at once is the budget the main agent started the workflow with, so only it changes it.
    if (lead !== undefined) throw new Error('Only the main agent can change maxConcurrent');
    if (state.parent) throw new Error('A child workflow runs within its root\'s concurrency; change the root workflow');
    const maxConcurrent = boundedInteger(input.maxConcurrent, state.definition.maxConcurrentWorkers, 1, MAX_CONCURRENT_WORKERS);
    if (maxConcurrent !== state.definition.maxConcurrentWorkers) emit(state, { type: 'concurrency_changed', maxConcurrentWorkers: maxConcurrent });
    result.maxConcurrent = maxConcurrent;
  }
  if (input.maxTurns !== undefined) {
    const maxTurns = boundedInteger(input.maxTurns, swarm.maxTurns, 1, SWARM_MAX_TURNS);
    if (maxTurns < swarm.maxTurns) throw new Error(`maxTurns can only be raised; it is ${swarm.maxTurns}`);
    if (maxTurns > swarm.maxTurns) emit(state, { type: 'swarm_turns_extended', swarmId: swarm.id, maxTurns });
    result.maxTurns = maxTurns;
  }
  if (input.revive !== undefined) {
    const failed = swarm.members.filter(member => member.stopped === 'failed');
    const names = input.revive === 'failed' ? failed.map(member => member.name)
      : Array.isArray(input.revive) ? input.revive.map(name => scriptText(name, 'member name', 100)) : undefined;
    if (!names) throw new Error('revive is "failed" or an array of member names');
    for (const name of names) {
      const member = swarm.members.find(item => item.name === name);
      if (!member) throw new Error('Unknown swarm member: ' + name);
      if (member.stopped !== 'failed') throw new Error(`Member ${name} has not failed`);
      // Cleaning a member gives up its worktree for good; a replacement starts from the workflow's checkout.
      if (member.cleaned) throw new Error(`Member ${name}'s worktree was cleaned; add a replacement instead`);
      const task = taskById(state, member.taskId);
      if (task && BUSY.has(task.status)) throw new Error(`Member ${name} is still stopping; try again shortly`);
      // Its last turn runs again in the same native session, as it would after a replay.
      if (task && task.status !== 'result_ready') {
        emit(state, { type: 'task_requeued', taskId: task.taskId, runId: state.script!.runId });
        // A turn that failed before a replay is not among the calls the swarm carried into this run. Left out, the
        // member's history would end one turn short of the turn it finishes, and it could not be woken again.
        if (!state.script!.calls.some(call => call.taskId === task.taskId)) emit(state, { type: 'script_call_recorded', call: { key: task.scriptKey!, taskId: task.taskId, cached: false } });
      }
      emit(state, { type: 'swarm_member_revived', swarmId: swarm.id, member: name });
    }
    result.revived = names;
  }
  if (input.retire !== undefined) {
    if (!Array.isArray(input.retire) || !input.retire.length) throw new Error('retire is an array of member names');
    const names = input.retire.map(name => scriptText(name, 'member name', 100));
    for (const name of names) {
      const member = swarm.members.find(item => item.name === name);
      if (!member) throw new Error('Unknown swarm member: ' + name);
      if (name === swarm.lead) throw new Error('The lead cannot be retired; it ends the swarm with swarm_finish');
      // The turn it is running finishes; it is not woken again. A member that failed is given up, and nobody is asked about it any more.
      if (member.stopped !== 'retired') emit(state, { type: 'swarm_member_stopped', swarmId: swarm.id, member: name, reason: 'retired' });
    }
    result.retired = names;
  }
  if (input.move !== undefined) {
    // Members follow the work: where one queue has more than its members can do and another has members without
    // work, moving them is the alternative to making up work for the idle ones or retiring them.
    if (!Array.isArray(input.move) || !input.move.length || input.move.length > 256) throw new Error('move is an array of 1–256 member names; queue names the work queue they go to');
    if (input.queue === undefined) throw new Error('move needs queue, the work queue the members go to');
    const to = queueName(input.queue);
    if (queueControl(state, to)?.closedAt !== undefined) throw new Error(`Work queue "${to}" is closed and takes no more work`);
    const described = role(input.role);
    const moving = new Map<string, string>();
    for (const name of input.move.map(name => scriptText(name, 'member name', 100))) {
      const member = swarm.members.find(item => item.name === name);
      if (!member) throw new Error('Unknown swarm member: ' + name);
      if (member.stopped) throw new Error(`Member ${name} has stopped`);
      if (!member.queue || coordinates(swarm, member)) throw new Error(`Member ${name} does not consume a work queue; move takes the members of one queue to the work of another`);
      if (member.queue !== to) moving.set(name, member.queue);
    }
    if (moving.size) openQueue(state, to);
    // The item a member holds stays its own to finish; what was kept for it in the queue it leaves opens to that queue.
    for (const name of moving.keys()) emit(state, { type: 'swarm_member_moved', swarmId: swarm.id, member: name, queue: to, ...(described === undefined ? {} : { role: described }) });
    result.moved = [...moving.keys()];
    // A queue that lost its last member keeps its unfinished items, which nobody will take until one is moved back.
    const unconsumed = [...new Set(moving.values())].filter(name => !swarm.members.some(member => member.queue === name && !member.stopped) && unfinishedWork(state, name));
    if (unconsumed.length) result.unconsumed = unconsumed;
  }
  if (input.cleanup !== undefined) {
    const pending = pendingCleanup(swarm, cleanupNames(swarm, input.cleanup));
    const done = new Set(cleanedUp?.map(item => item.name) ?? []);
    const cleaned: string[] = [];
    for (const item of pending) {
      if (!done.has(item.name)) throw new Error('The worktrees of the named members were not cleaned up');
      emit(state, { type: 'swarm_member_workspace_cleaned', swarmId: swarm.id, member: item.name });
      cleaned.push(item.name);
    }
    result.cleaned = cleaned;
  }
  if (input.add !== undefined) {
    if (!Array.isArray(input.add) || !input.add.length || input.add.length > 256) throw new Error('add is an array of 1–256 new member names');
    const names = input.add.map(memberName);
    if (new Set(names).size !== names.length) throw new Error('Member names must be unique');
    assertRoomFor(swarm, names);
    const like = likeMember(swarm, input.like);
    const binding = chosen ? execution! : like.execution as WorkerExecution;
    const led = input.leads === undefined ? undefined : ledQueues(input.leads);
    if (led) {
      if (!swarm.lead) throw new Error('The lead of a queue reports to the swarm lead, and this swarm has none');
      if (names.length !== 1) throw new Error('leads makes one member the lead of its queues; add that member alone');
      if (input.queue !== undefined) throw new Error('A member that leads queues plans their work and does not consume a queue');
      const taken = led.find(name => queueLead(swarm, name));
      if (taken) throw new Error(`Queue "${taken}" already has a lead: ${queueLead(swarm, taken)!.name}`);
      for (const name of led) openQueue(state, name);
    }
    // The lead the new lead answers to, when that is not the lead of the swarm.
    const under = input.under === undefined ? undefined : scriptText(input.under, 'under', 100).replace(/^@/, '');
    if (under !== undefined && !led) throw new Error('under names the lead a new lead answers to; give it with leads');
    if (under !== undefined && !swarm.members.some(member => member.name === under && !member.stopped && member.leads?.length)) {
      throw new Error(`under names a running member that leads queues; "${under.slice(0, 60)}" is not one (a lead answers to the swarm lead when it names none)`);
    }
    // A member that leads queues takes over the binding of the member it is added like, but neither its queue nor its role.
    const queue = led ? undefined : input.queue === undefined ? like.queue ?? (swarm.lead ? 'default' : undefined) : queueName(input.queue);
    const brief = input.brief === undefined ? undefined : scriptText(input.brief, 'member brief', 4000);
    const described = input.role === undefined ? (led ? undefined : like.role) : role(input.role);
    if (workspaceWanted && like.workflowTool) throw new Error('Workspace v1 does not support nested workflow delegation');
    if (workspaceWanted && names.some(name => !workspaces?.[name])) throw new Error('The worktrees of the new members were not resolved');
    if (queue) openQueue(state, queue);
    for (const name of names) {
      if (nameTaken(state, name)) throw new Error('Member name is already used in this workflow: ' + name);
      const workspace = workspaceWanted ? workspaces![name] : undefined;
      emit(state, { type: 'swarm_member_added', swarmId: swarm.id, member: { name, execution: binding, turns: 0, added: true,
        ...(workspace ? { workspace } : {}),
        ...(described !== undefined ? { role: described } : {}), ...(brief !== undefined ? { brief } : {}), ...(like.workflowTool ? { workflowTool: true } : {}), ...(queue ? { queue } : {}),
        ...(led ? { leads: led, ...(under ? { under } : {}) } : {}) } });
    }
    if (led) {
      // The members already running were told who leads what in their first turn: the announcement brings them up to
      // date at their next one, and the post wakes the swarm's lead, which now has a part of the work to hand over.
      const text = `Member "${names[0]}" now leads ${led.length > 1 ? 'queues' : 'queue'} ${quoted(led)}: it plans their work, reads the results of their items and answers for what waits in them. `
        + `Members that consume ${led.length > 1 ? 'these queues' : 'this queue'}: it is the lead you ask. Lead: say in your status what its part must deliver, and let it split the work.`;
      const head = swarm.lead;
      systemPost(state, { text, topic: BOARD_ANNOUNCE_TOPIC, ...(head && state.agents?.some(agent => agent.key === head) ? { to: [head] } : {}) }, now);
      result.leads = led;
    }
    result.added = names;
    if (workspaceWanted) result.workspaces = names.map(name => ({ name, workspace: workspaces![name]! }));
    if (chosen) result.execution = { agentKind: binding.agentKind, ...binding.modelSettings };
  }
  return result;
}

/**
 * A member's request to be woken after a delay. Members otherwise run only when something waits on them or their
 * queue has work, so one that waits for a long job, or wants to look at something again later, had to hold its turn open.
 */
export function setMemberTimer(state: WorkflowView, caller: string, input: Record<string, unknown>, now: number): unknown {
  const swarm = ownerOf(state, caller);
  if (!swarm || swarm.status !== 'running' || swarm.runId !== state.script?.runId) throw new Error('wake_me is for the members of a running swarm');
  if (swarm.finish) throw new Error('Swarm is already finishing');
  const member = swarm.members.find(item => item.name === caller)!;
  if (input.afterMinutes === undefined) throw new Error('Give afterMinutes; 0 cancels the wake-up');
  const minutes = boundedInteger(input.afterMinutes, 0, 0, WAKE_MAX_MINUTES);
  if (!minutes) {
    if (member.wakeAt !== undefined) emit(state, { type: 'swarm_member_timer_set', swarmId: swarm.id, member: caller });
    return { wakeAt: null };
  }
  if (!coordinates(swarm, member) && member.turns >= swarm.maxTurns) throw new Error('You have no wake-ups left; say what remains in the result of your item, or in a note');
  const note = input.note === undefined ? undefined : scriptText(input.note, 'note', 500).trim() || undefined;
  const at = now + minutes * 60_000;
  emit(state, { type: 'swarm_member_timer_set', swarmId: swarm.id, member: caller, at, ...(note ? { note } : {}) });
  return { wakeAt: new Date(at).toISOString() };
}

/**
 * The lead that planned an item, which is who its outcome goes to: the lead that added it, else the lead of its queue,
 * else the swarm's lead. It is also who answers for what keeps the item from being handed out.
 */
export function plannedBy(swarm: SwarmView, item: ItemView): MemberView | undefined {
  const author = swarm.members.find(member => member.name === item.by && !member.stopped);
  return (author && coordinates(swarm, author) ? author : undefined) ?? answersFor(swarm, item.queue ?? 'default');
}

/**
 * What a member may do to work items: the swarm's lead plans every queue, the lead of a queue its own, and any member
 * may withdraw an item it added.
 */
export function workAuthority(state: WorkflowView, caller: string): WorkAuthority {
  const swarm = ownerOf(state, caller);
  const member = swarm?.members.find(item => item.name === caller);
  const runs = Boolean(swarm && member && !member.stopped && swarm.status === 'running' && swarm.runId === state.script?.runId);
  return item => runs && plansQueue(swarm!, member!, item.queue ?? 'default') ? 'plans' : item.by === caller ? 'added' : undefined;
}

/**
 * The member a lead may speak to directly, and how the lead stands to it. The swarm's lead speaks to every member of
 * its swarm, another lead to the members that work under it; everyone else asks.
 */
export function tellTarget(state: WorkflowView, caller: string, target: unknown): { member: string; standing: 'swarm' | 'queue' } {
  const swarm = ownerOf(state, caller);
  const from = swarm?.members.find(item => item.name === caller);
  if (!swarm || !from || from.stopped || swarm.status !== 'running' || swarm.runId !== state.script?.runId || !coordinates(swarm, from)) {
    throw new Error('tell_worker is for the lead of a running swarm and the leads of its queues; ask the member with ask({to, text}) instead');
  }
  const name = scriptText(target, 'target', 200).replace(/^@/, '');
  const to = swarm.members.find(item => item.name === name);
  if (!to) throw new Error(`Unknown member of swarm "${swarm.key}": ${name.slice(0, 80)}`);
  if (to === from) throw new Error('tell_worker speaks to another member');
  const standing = swarm.lead === caller ? 'swarm' : 'queue';
  if (standing === 'queue' && !chainAbove(swarm, to).includes(from)) {
    throw new Error(`Member "${name}" does not work under you; ask it, or ask the lead (${swarm.lead})`);
  }
  return { member: name, standing };
}

/**
 * Whether words left for the member will be read: it has had a turn, so it has an inbox, and another turn can still
 * come. A swarm member that has stopped, or whose swarm is over or finishing, is not woken again. `later` also counts
 * the turns that a paused or interrupted workflow will run once it goes on.
 */
export function readsPosts(state: WorkflowView, name: string, later = false): boolean {
  // The main agent also speaks to a workflow that is paused or interrupted: the words wait for the run to go on.
  const live = later ? ['active', 'paused', 'interrupted'].includes(state.status) && state.script !== undefined && state.script.status !== 'result_ready'
    : state.status === 'active' && state.script?.status === 'running';
  if (!live || !state.agents?.some(agent => agent.key === name)) return false;
  const swarm = ownerOf(state, name);
  return !swarm || swarm.status === 'running' && swarm.runId === state.script!.runId && !swarm.finish && !swarm.members.find(item => item.name === name)!.stopped;
}

export function finishSwarm(state: WorkflowView, caller: string, input: Record<string, unknown>): unknown {
  const swarm = leadSwarm(state, caller);
  emit(state, { type: 'swarm_finish_requested', swarmId: swarm.id, result: scriptText(input.result, 'swarm result', 16_000) });
  return { finishing: true };
}

function memberSummary(state: WorkflowView, swarm: SwarmView, member: MemberView) {
  const task = taskById(state, member.taskId);
  const status = member.stopped ?? (task && BUSY.has(task.status) ? 'running' : swarm.status === 'running' ? 'waiting' : !coordinates(swarm, member) && member.turns >= swarm.maxTurns ? 'max_turns' : 'idle');
  const usual = likeMember(swarm, undefined).execution;
  const model = member.execution.modelSettings.model;
  return { name: member.name, ...(member.name === swarm.lead ? { lead: true } : {}), ...(member.leads?.length ? { leads: member.leads } : {}), ...(member.queue ? { queue: member.queue } : {}), ...(member.added ? { added: true } : {}), ...(member.cleaned ? { cleaned: true } : {}),
    // Only the members bound unlike the rest carry their binding, which keeps a large swarm's summary short.
    ...(member.execution.agentKind !== usual.agentKind ? { harness: member.execution.agentKind } : {}),
    ...(model && (model !== usual.modelSettings.model || member.execution.agentKind !== usual.agentKind) ? { model } : {}), turns: member.turns, status,
    ...(member.itemsDone ? { itemsDone: member.itemsDone } : {}), ...(member.itemsFailed ? { itemsFailed: member.itemsFailed } : {}),
    ...(member.wakeAt !== undefined ? { wakeAt: member.wakeAt } : {}), ...(member.detail ? { error: member.detail } : {}) };
}

/**
 * Supply and demand of each queue the swarm consumes: how many of its pending items can be claimed now and how many
 * wait on something, against the members that are working and the ones with nothing to do. With the time, also how
 * the queue has moved: what entered and left it in each of the last hours (`flow`), and how often and for how long
 * its members sat idle with nothing to claim (`dry`).
 */
function queueSummary(state: WorkflowView, swarm: SwarmView, now?: number): Record<string, unknown> | undefined {
  const names = [...new Set(swarm.members.flatMap(member => member.queue && !member.stopped ? [member.queue] : []))];
  if (!names.length) return undefined;
  return Object.fromEntries(names.map(name => {
    const items = (state.workQueue?.items ?? []).filter(item => (item.queue ?? 'default') === name);
    const { claimable, blocked, onHold, heldReady, stuck, gates } = queueStanding(state, name);
    const members = swarm.members.filter(member => member.queue === name && !member.stopped);
    const running = members.filter(member => { const task = taskById(state, member.taskId); return Boolean(task && BUSY.has(task.status)); }).length;
    const own = queueLead(swarm, name);
    const flow = now === undefined ? undefined : workFlow(state, name, now);
    const dry = swarm.dry?.[name];
    const minutes = (ms: number) => Math.round(ms / 6000) / 10;
    return [name, { ...(own ? { lead: own.name } : {}), claimable, blocked, ...(onHold ? { onHold } : {}), ...(heldReady ? { heldReady } : {}), ...(stuck ? { stuck } : {}), ...(gates ? { gates } : {}), claimed: items.filter(item => item.status === 'claimed').length,
      members: members.length, running, idle: members.length - running,
      ...(flow ? { flow } : {}), ...(dry ? { dry: { spells: dry.spells, minutes: minutes(dry.ms), longestMinutes: minutes(dry.longest) } } : {}) }];
  }));
}

export function swarmSummary(state: WorkflowView, swarm: SwarmView, now?: number): unknown {
  const queues = swarm.status === 'running' ? queueSummary(state, swarm, now) : undefined;
  return { key: swarm.key, status: swarm.status, stop: swarm.stop, reason: swarm.reason, lead: swarm.lead, maxTurns: swarm.maxTurns, turns: turnCount(swarm),
    posts: boardTotal(state) - swarm.firstPost + 1, ...(queues ? { queues } : {}), members: swarm.members.map(member => memberSummary(state, swarm, member)) };
}

/** What `swarm()` resolves to once the swarm has ended; undefined while it runs. */
export function swarmResult(state: WorkflowView, key: string): unknown | undefined {
  const swarm = state.swarms?.find(item => item.key === key);
  if (!swarm) throw new Error('Unknown swarm');
  if (swarm.status === 'running') return undefined;
  if (swarm.stop === 'failed' && swarm.reason) throw new Error(swarm.reason);
  const board = readBoard(state, { after: swarm.firstPost - 1, limit: 50, upTo: swarm.lastPost });
  const queues = [...new Set(swarm.members.flatMap(member => member.queue ? [member.queue] : []))];
  // The whole result must fit a script value, so a large swarm gets shorter notes.
  const noteChars = Math.min(2000, Math.floor(40_000 / swarm.members.length));
  return { stop: swarm.stop, ...(swarm.finish ? { result: swarm.finish.result } : {}), turns: turnCount(swarm),
    members: swarm.members.map(member => {
      const latest = [...swarm.turns].reverse().map(turn => taskById(state, turn.taskId)).find(task => task?.status === 'result_ready' && state.agents?.find(agent => agent.agentId === task.agentId)?.key === member.name);
      const ref = latest?.resultRefs.at(-1);
      return { ...memberSummary(state, swarm, member), note: ref ? readArtifact(state, ref).text.slice(0, noteChars) : null };
    }),
    ...(queues.length ? { queues: Object.fromEntries(queues.map(name => [name, workStatus(state, { queue: name })])) } : {}),
    posts: board.posts, lastSeq: board.lastSeq, hasMore: board.hasMore };
}
