import { randomUUID } from 'node:crypto';
import { postToBoard, readBoard } from './board';
import { workflowDigest } from './digest';
import { availableMessages, receiveMessages, scheduleMemberTurn } from './durable-agents';
import type { DomainEvent } from './events';
import { readArtifact, taskById } from './kernel-state';
import { emit, readText } from './kernel-store';
import { boundedInteger, parseScriptAgentCall, scriptText } from './script-contract';
import { consumerPools, memberPool } from './work-routing';
import type { Immutable, NativeIdKind, SwarmMember, WorkerExecution, WorkerExecutionPolicy, WorkflowSwarm, WorkflowTask, WorkflowView } from './types';

const BUSY = new Set<WorkflowTask['status']>(['queued', 'starting', 'running', 'cancelling', 'waiting_workflow']);
const NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const RESERVED = ['all', 'main', 'script', 'system'];
const MAX_MEMBERS = 16;
/** How often an idle swarm reminds its lead to finish before it ends without a verdict. */
const MAX_NUDGES = 2;

type SwarmView = Immutable<WorkflowSwarm>;
type MemberView = Immutable<SwarmMember>;

function memberName(value: unknown): string {
  const name = scriptText(value, 'swarm member name', 100);
  if (!NAME.test(name) || RESERVED.includes(name)) throw new Error('Swarm member names use 1–40 letters, digits, _, . or -, and cannot be all, main, script or system');
  return name;
}

function role(value: unknown): string | undefined {
  return value === undefined ? undefined : scriptText(value, 'swarm member role', 2000);
}

export function parseSwarm(input: Record<string, unknown>, state: WorkflowView, policy?: WorkerExecutionPolicy) {
  if (Object.keys(input).some(key => !['key', 'task', 'lead', 'members', 'maxTurns'].includes(key))) throw new Error('swarm supports key, lead, members and maxTurns only');
  const key = scriptText(input.key, 'swarm key', 80);
  if (key.trim() !== key || key.startsWith('@')) throw new Error('swarm key must not contain surrounding whitespace or start with @');
  const task = scriptText(input.task, 'swarm task', 16_000);
  if (!task.trim()) throw new Error('swarm needs a task');
  const maxTurns = boundedInteger(input.maxTurns, 6, 1, 24);
  if (!Array.isArray(input.members) || !input.members.length) throw new Error('swarm needs members');
  const listed = [...(input.lead === undefined ? [] : [input.lead]), ...input.members];
  if (listed.length < 2 || listed.length > 12) throw new Error('swarm needs 2–12 members, the lead included');
  const members = listed.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid swarm member');
    const { name, role: description, ...options } = value as Record<string, unknown>;
    if (Object.keys(options).some(option => !['harness', 'model', 'reasoningEffort', 'workflowTool', 'workspace'].includes(option))) throw new Error('Unsupported swarm member option');
    const call = parseScriptAgentCall({ ...options, key, member: memberName(name), prompt: task }, state.script!.defaults, state.root, policy);
    return { name: call.member!, role: role(description), selection: call.selection, ...(call.workflowTool ? { workflowTool: true } : {}), ...(call.workspace ? { workspace: call.workspace } : {}) };
  });
  if (new Set(members.map(member => member.name)).size !== members.length) throw new Error('Swarm member names must be unique');
  return { key, task, maxTurns, members, ...(input.lead === undefined ? {} : { lead: members[0]!.name }) };
}

function ownerOf(state: WorkflowView, name: string | undefined): SwarmView | undefined {
  return state.swarms?.find(swarm => swarm.members.some(member => member.name === name));
}

/** The swarm a member belongs to; its turns are scheduled by the kernel, not by script calls. */
export const memberSwarm = ownerOf;

function nameTaken(state: WorkflowView, name: string): boolean {
  return Boolean(state.agents?.some(agent => agent.key === name) || memberPool(state, name) || ownerOf(state, name));
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
    if (consumerPools(state).some(pool => pool.key === spec.key)) throw new Error('Swarm key already belongs to a consumer pool');
    if (spec.members.some(member => nameTaken(state, member.name))) throw new Error('Swarm requires dedicated member names not already used in this workflow');
    const brief = postToBoard(state, { author: 'script' }, { text: `Swarm "${spec.key}" task:\n` + (spec.task.length > 3800 ? spec.task.slice(0, 3800) + '…[truncated]' : spec.task) }, now);
    const created: WorkflowSwarm = { id: randomUUID(), key: spec.key, digest, runId, task: spec.task, maxTurns: spec.maxTurns, status: 'running',
      firstPost: brief.seq, nudges: 0, turns: [], ...(spec.lead ? { lead: spec.lead } : {}),
      members: spec.members.map((member, index) => ({ name: member.name, execution: executions[index]!, turns: 0,
        ...(member.role !== undefined ? { role: member.role } : {}), ...(member.workflowTool ? { workflowTool: true } : {}), ...(member.workspace ? { workspace: member.workspace } : {}) })) };
    emit(state, { type: 'swarm_created', swarm: created });
    return;
  }
  // Rebuild each member's committed turn chain without running its completed turns again.
  const completed = swarm.turns.filter(turn => taskById(state, turn.taskId)?.status === 'result_ready');
  if (state.script!.calls.length + completed.length > state.script!.maxCalls) throw new Error('Script agent call limit reached');
  for (const turn of completed) emit(state, { type: 'script_call_recorded', call: { key: turn.key, taskId: turn.taskId, cached: true } });
  const retryPending = swarm.members.filter(member => !member.stopped && member.taskId && taskById(state, member.taskId)?.status !== 'result_ready').map(member => member.name);
  emit(state, { type: 'swarm_rebound', swarmId: swarm.id, runId, retryPending });
}

function rules(swarm: SwarmView, member: MemberView): string {
  const lead = swarm.lead === member.name;
  return [
    'How the swarm works:',
    '- The board is one ordered feed that every member can read. Post with post_board and name who must act in "to" (member names, or "all"); read with read_board.',
    '- Your turn ends with your final answer. You then sleep at no cost and are woken only when a post names you; those posts arrive in read_context (member.messages).',
    '- Post results, questions, hand-offs and blockers that others need, with enough detail to act on. Do not post acknowledgements or thanks: every post that names a member costs that member a turn.',
    `- After this first turn you can be woken at most ${swarm.maxTurns} times. Save a checkpoint of your working state before ending a turn. Your final answer is a short status note for the workflow log; teammates only see board posts.`,
    ...(lead ? [
      '- You are the lead. You split the work, assign it on the board, judge results and decide when the swarm is done. The system posts to you when a member fails and when everyone has gone idle.',
      '- swarm_add_member adds a member while the swarm runs and swarm_retire_member stops one. Call swarm_finish with the final result once the task is complete or cannot progress; the swarm ends when the turns still running have finished.',
    ] : swarm.lead ? [`- @${swarm.lead} is the lead: it assigns work and decides when the swarm is done. Report results and blockers to it. When you have nothing to report and need nothing, end the turn without posting.`]
      : ['- When you need nothing from anyone and have nothing to report, end the turn without posting. The swarm finishes when everyone is asleep.']),
  ].join('\n');
}

function openingPrompt(swarm: SwarmView, member: MemberView): string {
  const roster = swarm.members.filter(item => !item.stopped).map(item => '@' + item.name + (item.name === swarm.lead ? ' (lead)' : '') + (item.role ? ' — ' + item.role : '')).join('\n');
  return `You are member "${member.name}" of swarm "${swarm.key}", which coordinates through a shared message board.`
    + (member.role ? '\nYour role: ' + member.role : '') + '\nMembers:\n' + roster + '\nTask:\n' + swarm.task
    + (member.brief ? '\nThe lead added you while the swarm was running, with this brief:\n' + member.brief : '') + '\n' + rules(swarm, member)
    + '\nThis is your first turn. Start on your part of the task now; if your role only reacts to others, end the turn with a one-line note.';
}

function wakePrompt(swarm: SwarmView, member: MemberView): string {
  return `Swarm "${swarm.key}", wake-up ${member.turns + 1} of at most ${swarm.maxTurns}: board posts that name you are in read_context (member.messages). `
    + 'Act on them, use read_board for wider context, and post what others need. End with a short status note.';
}

/** Schedules the turns of every running swarm and settles the ones with nothing left to do. Returns whether anything changed. */
export function pumpSwarms(state: WorkflowView, nativeIdKind: (agentKind: string) => NativeIdKind, now: number, additionalTurnsAllowed = Infinity): boolean {
  let changed = false;
  for (const swarm of state.swarms ?? []) {
    const before = swarm.turns.length;
    changed = pumpSwarm(state, swarm, nativeIdKind, now, additionalTurnsAllowed) || changed;
    additionalTurnsAllowed -= swarm.turns.length - before;
  }
  return changed;
}

function pumpSwarm(state: WorkflowView, swarm: SwarmView, nativeIdKind: (agentKind: string) => NativeIdKind, now: number, additionalTurnsAllowed: number): boolean {
  if (swarm.runId !== state.script?.runId || state.status !== 'active' || state.script.status !== 'running' || swarm.status !== 'running') return false;
  let changed = false;
  const record = (event: DomainEvent) => { emit(state, event); changed = true; };
  const end = (stop: NonNullable<WorkflowSwarm['stop']>, reason?: string) => record({ type: 'swarm_ended', swarmId: swarm.id, stop, ...(reason ? { reason } : {}) });
  const taskOf = (member: MemberView) => taskById(state, member.taskId);
  const busy = (member: MemberView) => { const task = taskOf(member); return Boolean(task && BUSY.has(task.status)); };
  const agentOf = (member: MemberView) => state.agents?.find(agent => agent.key === member.name);
  const unread = (member: MemberView) => { const agent = agentOf(member); return Boolean(agent && availableMessages(state, agent.agentId).length); };
  const notifyLead = (text: string) => {
    const lead = swarm.members.find(member => member.name === swarm.lead);
    if (!lead || lead.stopped || !agentOf(lead)) return;
    postToBoard(state, { author: 'system' }, { text, to: [lead.name] }, now);
    changed = true;
  };
  try {
    // A turn that ended without a result during this run is a failure; turns cut short by a pause are retried instead.
    for (const member of swarm.members) {
      const task = taskOf(member);
      if (member.stopped || member.retryPending || !task || BUSY.has(task.status) || task.status === 'result_ready') continue;
      const detail = (task.error ?? `turn is ${task.status}`).slice(0, 500);
      record({ type: 'swarm_member_stopped', swarmId: swarm.id, member: member.name, reason: 'failed', detail });
      // Naming the member without @ keeps the notice from being delivered to it.
      if (member.name !== swarm.lead && !swarm.finish) notifyLead(`Member "${member.name}" failed and has stopped: ${detail}\nReassign its work, add a replacement with swarm_add_member, or finish.`);
    }
    const lead = swarm.members.find(member => member.name === swarm.lead);
    // Once the lead has finished the swarm, the turns still running end it; nobody is woken again.
    const wakeable = (member: MemberView) => !member.stopped && !busy(member) && !swarm.finish
      && (!member.taskId || member.retryPending || member.turns < swarm.maxTurns && unread(member));
    if (!swarm.members.some(busy) && !swarm.members.some(wakeable)) {
      if (lead?.stopped === 'failed') { end('failed', 'The lead failed: ' + (lead.detail ?? '')); return changed; }
      if (swarm.finish) { end('finished'); return changed; }
      if (lead && !lead.stopped && lead.turns < swarm.maxTurns && swarm.nudges < MAX_NUDGES) {
        record({ type: 'swarm_nudged', swarmId: swarm.id });
        notifyLead('Every member is idle and nothing is waiting to be read. Assign further work on the board, or call swarm_finish with the final result.');
      } else {
        const active = swarm.members.filter(member => !member.stopped || member.stopped === 'failed');
        end(active.some(member => member.stopped === 'failed') ? 'failed' : active.some(member => member.turns >= swarm.maxTurns && unread(member)) ? 'max_turns' : 'quiet');
        return changed;
      }
    }
    let slots = state.definition.maxConcurrentWorkers - state.tasks.filter(task => BUSY.has(task.status)).length;
    for (const member of swarm.members) {
      if (slots <= 0) break;
      if (!wakeable(member)) continue;
      if (member.workspace && state.tasks.some(task => task.workspaceId === member.workspace && (BUSY.has(task.status) || task.status === 'waiting_workflow'))) continue;
      const prior = taskOf(member);
      const retry = Boolean(member.retryPending && prior);
      if (state.script.calls.length >= state.script.maxCalls || !retry && additionalTurnsAllowed <= 0) {
        if (!swarm.members.some(busy)) end('failed', 'Swarm ran out of the workflow\'s agent call budget; raise maxAgents or reduce members and maxTurns');
        break;
      }
      const opening = !member.taskId;
      const key = retry ? prior!.scriptKey! : `@swarm/${swarm.id}/${swarm.turns.length}`;
      const call = { key, member: member.name, prompt: retry ? readText(state, prior!.objective) : opening ? openingPrompt(swarm, member) : wakePrompt(swarm, member),
        ...(member.workflowTool ? { workflowTool: true } : {}), ...(member.workspace ? { workspace: member.workspace } : {}),
        output: 'text' as const, selection: { agentKind: member.execution.agentKind, ...member.execution.modelSettings } };
      if (!retry && !opening) receiveMessages(state, member.name, key + '/inbox');
      const { task } = scheduleMemberTurn(state, call, member.execution, nativeIdKind(member.execution.agentKind));
      record({ type: 'swarm_turn_scheduled', swarmId: swarm.id, member: member.name, key, taskId: task.taskId, retry, opening });
      record({ type: 'script_call_recorded', call: { key, taskId: task.taskId, cached: false } });
      if (!retry) additionalTurnsAllowed--;
      slots--;
    }
  } catch (error) { end('failed', error instanceof Error ? error.message : String(error)); }
  return changed;
}

/** The lead of a running swarm, for the management operations only it may call. */
function leadSwarm(state: WorkflowView, caller: string): SwarmView {
  const swarm = ownerOf(state, caller);
  if (!swarm || swarm.lead !== caller) throw new Error('Only the lead of a swarm can manage it');
  if (swarm.status !== 'running' || swarm.runId !== state.script?.runId) throw new Error('Swarm is no longer running');
  if (swarm.finish) throw new Error('Swarm is already finishing');
  return swarm;
}

/** A new member runs with the execution binding of an existing one, so a lead cannot reach harnesses or models nobody authorized. */
export function addSwarmMember(state: WorkflowView, caller: string, input: Record<string, unknown>): unknown {
  const swarm = leadSwarm(state, caller);
  const name = memberName(input.name);
  if (nameTaken(state, name)) throw new Error('Member name is already used in this workflow: ' + name);
  if (swarm.members.length >= MAX_MEMBERS) throw new Error(`A swarm holds at most ${MAX_MEMBERS} members, retired ones included`);
  const like = input.like === undefined ? swarm.members.find(member => member.name !== caller) ?? swarm.members[0]! : swarm.members.find(member => member.name === input.like);
  if (!like) throw new Error('like must name an existing member of this swarm');
  const member: SwarmMember = { name, execution: like.execution as WorkerExecution, turns: 0, added: true,
    ...(input.role !== undefined ? { role: role(input.role) } : {}), ...(input.brief !== undefined ? { brief: scriptText(input.brief, 'member brief', 4000) } : {}),
    ...(like.workflowTool ? { workflowTool: true } : {}) };
  emit(state, { type: 'swarm_member_added', swarmId: swarm.id, member });
  return { member: name, like: like.name, harness: like.execution.agentKind, model: like.execution.modelSettings.model };
}

export function retireSwarmMember(state: WorkflowView, caller: string, input: Record<string, unknown>): unknown {
  const swarm = leadSwarm(state, caller);
  const name = scriptText(input.name, 'member name', 100);
  const member = swarm.members.find(item => item.name === name);
  if (!member) throw new Error('Unknown swarm member: ' + name);
  if (name === caller) throw new Error('The lead cannot retire itself; call swarm_finish instead');
  if (!member.stopped) emit(state, { type: 'swarm_member_stopped', swarmId: swarm.id, member: name, reason: 'retired' });
  return { member: name, stopped: member.stopped ?? 'retired' };
}

export function finishSwarm(state: WorkflowView, caller: string, input: Record<string, unknown>): unknown {
  const swarm = leadSwarm(state, caller);
  emit(state, { type: 'swarm_finish_requested', swarmId: swarm.id, result: scriptText(input.result, 'swarm result', 16_000) });
  return { finishing: true };
}

function memberSummary(state: WorkflowView, swarm: SwarmView, member: MemberView) {
  const task = taskById(state, member.taskId);
  const status = member.stopped ?? (task && BUSY.has(task.status) ? 'running' : swarm.status === 'running' ? 'waiting' : member.turns >= swarm.maxTurns ? 'max_turns' : 'idle');
  return { name: member.name, ...(member.name === swarm.lead ? { lead: true } : {}), ...(member.added ? { added: true } : {}), turns: member.turns, status,
    ...(member.detail ? { error: member.detail } : {}) };
}

export function swarmSummary(state: WorkflowView, swarm: SwarmView): unknown {
  return { key: swarm.key, status: swarm.status, stop: swarm.stop, reason: swarm.reason, lead: swarm.lead, maxTurns: swarm.maxTurns, turns: swarm.turns.length,
    posts: (state.board?.posts.length ?? 0) - swarm.firstPost + 1, members: swarm.members.map(member => memberSummary(state, swarm, member)) };
}

/** What `swarm()` resolves to once the swarm has ended; undefined while it runs. */
export function swarmResult(state: WorkflowView, key: string): unknown | undefined {
  const swarm = state.swarms?.find(item => item.key === key);
  if (!swarm) throw new Error('Unknown swarm');
  if (swarm.status === 'running') return undefined;
  if (swarm.stop === 'failed' && swarm.reason) throw new Error(swarm.reason);
  const board = readBoard(state, { after: swarm.firstPost - 1, limit: 50, upTo: swarm.lastPost });
  return { stop: swarm.stop, ...(swarm.finish ? { result: swarm.finish.result } : {}), turns: swarm.turns.length,
    members: swarm.members.map(member => {
      const latest = [...swarm.turns].reverse().map(turn => taskById(state, turn.taskId)).find(task => task?.status === 'result_ready' && state.agents?.find(agent => agent.agentId === task.agentId)?.key === member.name);
      const ref = latest?.resultRefs.at(-1);
      return { ...memberSummary(state, swarm, member), note: ref ? readArtifact(state, ref).text.slice(0, 2000) : null };
    }),
    posts: board.posts, lastSeq: board.lastSeq, hasMore: board.hasMore };
}
