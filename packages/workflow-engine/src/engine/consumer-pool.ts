import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { availableMessages, receiveMessages, scheduleMemberTurn } from './durable-agents';
import type { DomainEvent } from './events';
import { taskById } from './kernel-state';
import { emit, readText } from './kernel-store';
import { boundedInteger, parseScriptAgentCall, scriptText } from './script-contract';
import { availableWork, openQueue, unfinishedWork, workStatus } from './work-queue';
import { consumerPools, memberPool, queueControl, queueName } from './work-routing';
import type { NativeIdKind, PoolView, WorkConsumerPool, WorkerExecution, WorkerExecutionPolicy, WorkflowTask, WorkflowView } from './types';

const BUSY = new Set<WorkflowTask['status']>(['queued', 'starting', 'running', 'cancelling', 'waiting_workflow']);
const CONSUMER_PROMPT = '\nUse claim_work to consume authorized work. Read item.progress before acting, save checkpoint_work, renew long-running claims, then complete_work or fail_work. Continue until claim_work returns null. Then return a final answer immediately to release your process; the bridge will schedule a new turn when work becomes available. Do not poll or sleep waiting for work. Follow the original goal and declared resource ownership.';
const FEEDBACK_PROMPT = '\nFirst read the delivered member-context messages and act on relevant feedback within the original task scope. They may be the only reason for this turn. Then consume any available work. Do not send acknowledgement-only replies that create message loops; send a message only when you have useful new evidence or need a concrete action. Feedback does not authorize editing resources outside a valid work claim.';

export function parseConsumerPool(input: Record<string, unknown>, state: WorkflowView, policy?: WorkerExecutionPolicy) {
  if (Object.keys(input).some(key => !['key', 'members', 'prompt', 'maxTurns', 'queue', 'maxConcurrent', 'wakeOnMessages'].includes(key))) throw new Error('Unsupported consumeWork option');
  const key = scriptText(input.key, 'consumer pool key', 100);
  if (key.trim() !== key) throw new Error('Consumer pool key must not contain surrounding whitespace');
  if (input.wakeOnMessages !== undefined && typeof input.wakeOnMessages !== 'boolean') throw new Error('wakeOnMessages must be boolean');
  const prompt = scriptText(input.prompt, 'consumer prompt', 16_000) + (input.wakeOnMessages ? FEEDBACK_PROMPT : '') + CONSUMER_PROMPT;
  const maxTurns = boundedInteger(input.maxTurns, Math.min(32, state.script!.maxCalls), 1, 128);
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > 16) throw new Error('Consumer pool needs 1–16 members');
  const members = input.members.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid consumer member');
    const { name, ...options } = value as Record<string, unknown>;
    if (Object.keys(options).some(key => !['harness', 'model', 'reasoningEffort', 'workflowTool'].includes(key))) throw new Error('Unsupported consumer member option');
    return parseScriptAgentCall({ ...options, key, member: scriptText(name, 'consumer name', 100), prompt }, state.script!.defaults, state.root, policy);
  });
  if (new Set(members.map(member => member.member)).size !== members.length) throw new Error('Consumer member names must be unique');
  const name = queueName(input.queue);
  const maxConcurrent = input.maxConcurrent === undefined ? undefined : boundedInteger(input.maxConcurrent, 16, 1, 16);
  return { key, prompt, maxTurns, members, ...(name !== 'default' ? { queue: name } : {}), ...(maxConcurrent !== undefined ? { maxConcurrent } : {}), ...(input.wakeOnMessages ? { wakeOnMessages: true } : {}) };
}

/** Called after resolving and validating every member's current authorized execution binding. */
export function bindConsumerPool(state: WorkflowView, spec: ReturnType<typeof parseConsumerPool>, executions: WorkerExecution[]): void {
  const digest = workflowDigest({ spec, executions });
  let pool = consumerPools(state).find(pool => pool.key === spec.key);
  if (pool) {
    if (pool.key !== spec.key || pool.digest !== digest) throw new Error('Consumer pool definition changed; its key, inputs and member bindings are immutable across replay');
    if (pool.runId === state.script!.runId) throw new Error('Duplicate consumer pool call');
  } else {
    if (consumerPools(state).length >= 16) throw new Error('Consumer pool limit reached');
    if (spec.members.some(member => memberPool(state, member.member))) throw new Error('Consumer member already belongs to another pool');
    const names = new Set([...(state.agents ?? []).map(agent => agent.key), ...consumerPools(state).flatMap(pool => pool.members.map(member => member.name))]);
    if (names.size + spec.members.length > 32) throw new Error('Consumer member limit reached');
    if (state.agents?.some(agent => spec.members.some(member => member.member === agent.key))) throw new Error('Consumer pool requires dedicated member names not already used by agent()');
    openQueue(state, spec.queue ?? 'default');
    const created: WorkConsumerPool = { id: randomUUID(), key: spec.key, digest, runId: state.script!.runId,
      prompt: spec.prompt, maxTurns: spec.maxTurns, status: 'waiting', turns: [],
      ...(spec.queue ? { queue: spec.queue } : {}), ...(spec.maxConcurrent !== undefined ? { maxConcurrent: spec.maxConcurrent } : {}),
      ...(spec.wakeOnMessages ? { wakeOnMessages: true } : {}),
      members: spec.members.map((member, index) => ({ name: member.member!, execution: executions[index]!, ...(member.workflowTool ? {workflowTool:true} : {}) })) };
    emit(state, { type: 'pool_created', pool: created });
    pool = consumerPools(state).find(item => item.id === created.id)!;
  }
  // Reconstruct each member's committed predecessor chain without replaying its completed turns.
  const completed = pool.turns.filter(turn => taskById(state, turn.taskId)?.status === 'result_ready');
  if (state.script!.calls.length + completed.length > state.script!.maxCalls) throw new Error('Script agent call limit reached');
  for (const turn of completed) emit(state, { type: 'script_call_recorded', call: { key: turn.key, taskId: turn.taskId, cached: true } });
  const retryPending = pool.members.filter(member => {
    const task = taskById(state, member.taskId);
    return Boolean(task && task.status !== 'result_ready');
  }).map(member => member.name);
  emit(state, { type: 'pool_rebound', poolId: pool.id, runId: state.script!.runId, retryPending });
}

export function consumerSummary(state: WorkflowView, key?: string): unknown {
  const pool = key === undefined ? state.consumerPool : consumerPools(state).find(pool => pool.key === key);
  if (!pool) return undefined;
  return { key: pool.key, queue: pool.queue ?? 'default', maxConcurrent: pool.maxConcurrent, wakeOnMessages: pool.wakeOnMessages ?? false, status: pool.status, reason: pool.reason, turns: pool.turns.length, maxTurns: pool.maxTurns,
    members: pool.members.map(member => ({ name: member.name, taskId: member.taskId, retryPending: member.retryPending,
      status: member.disabled ? 'disabled' : BUSY.has(taskById(state, member.taskId)?.status ?? 'result_ready') ? 'running' : pool.status === 'drained' ? 'done' : 'waiting',
      reason: member.disabled })) };
}

export function consumerResult(state: WorkflowView, key?: string): unknown | undefined {
  const pool = key === undefined ? state.consumerPool : consumerPools(state).find(pool => pool.key === key);
  if (!pool) throw new Error('Unknown consumer pool');
  if (pool.status === 'failed') throw new Error(pool.reason ?? 'Consumer pool failed');
  if (pool.status === 'drained') return { queue: workStatus(state, { queue: pool.queue ?? 'default' }), consumers: consumerSummary(state, pool.key) };
  return undefined;
}

/** Synchronous queue reconciliation under the kernel's single-writer state boundary. Returns whether anything changed. */
export function pumpConsumerPool(state: WorkflowView, nativeIdKind: (agentKind: string) => NativeIdKind, additionalTurnsAllowed = Infinity): boolean {
  let changed = false;
  for (const pool of consumerPools(state).sort((a, b) => a.turns.length - b.turns.length)) {
    const before = pool.turns.length;
    changed = pumpPool(state, pool, nativeIdKind, additionalTurnsAllowed) || changed;
    additionalTurnsAllowed -= pool.turns.length - before;
  }
  return changed;
}

function pumpPool(state: WorkflowView, pool: PoolView, nativeIdKind: (agentKind: string) => NativeIdKind, additionalTurnsAllowed: number): boolean {
  if (pool.runId !== state.script?.runId || state.status !== 'active' || state.script?.status !== 'running'
    || !['waiting', 'running'].includes(pool.status)) return false;
  let changed = false;
  const record = (event: DomainEvent) => { emit(state, event); changed = true; };
  // Every pump recomputes the pool's status; only a real change becomes an event.
  const setStatus = (status: WorkConsumerPool['status'], reason: string | undefined) => {
    if (pool.status !== status || pool.reason !== reason) record({ type: 'pool_status_changed', poolId: pool.id, status, ...(reason !== undefined ? { reason } : {}) });
  };
  const tasks = () => pool.members.map(member => taskById(state, member.taskId));
  for (const member of pool.members) {
    const task = taskById(state, member.taskId);
    if (task && !BUSY.has(task.status) && task.status !== 'result_ready' && !member.retryPending) {
      const reason = task.error ?? `Consumer turn is ${task.status}; explicitly replay to retry it`;
      if (member.disabled !== reason) record({ type: 'pool_member_disabled', poolId: pool.id, member: member.name, reason });
    }
  }
  const active = tasks().filter(task => task && BUSY.has(task.status)).length;
  const fail = (reason: string) => setStatus('failed', reason);
  const name = pool.queue ?? 'default';
  const hasMessages = (name: string) => {
    const agent = pool.wakeOnMessages && state.agents?.find(agent => agent.key === name);
    return Boolean(agent && availableMessages(state, agent.agentId).length);
  };
  const messagesPending = pool.members.some(member => hasMessages(member.name)
    || member.retryPending && taskById(state, member.taskId)?.inputMessageIds?.length);
  const items = (state.workQueue?.items ?? []).filter(item => (item.queue ?? 'default') === name);
  const failedDependency = items.find(item => item.status === 'pending' && item.dependsOn?.some(key =>
    state.workQueue?.items.some(dependency => dependency.key === key && ['failed', 'cancelled'].includes(dependency.status))));
  if (items.some(item => item.status === 'failed') || failedDependency) {
    if (active) setStatus('running', pool.reason);
    else fail(failedDependency ? `Work dependency failed for ${failedDependency.key}; repair prerequisites and explicitly replay`
      : 'Work items failed; inspect /workflow work, retry the failed items, then explicitly replay');
    return changed;
  }
  if (!unfinishedWork(state, name) && !active && !messagesPending && queueControl(state, name)?.closedAt !== undefined) {
    setStatus('drained', undefined);
    return changed;
  }
  const available = availableWork(state, name);
  // A queued/running turn which has not claimed yet already represents demand for one item.
  const unclaimed = consumerPools(state).filter(other => (other.queue ?? 'default') === name).flatMap(other => other.members)
    .map(member => taskById(state, member.taskId)).filter(task => task && BUSY.has(task.status)
    && !task.consumerMessageTurn
    && !state.workQueue?.claims.some(claim => claim.taskId === task.taskId && claim.status === 'active')).length;
  let workSlots = available.length - unclaimed;
  let slots = Math.min(
    (pool.maxConcurrent ?? state.definition.maxConcurrentWorkers) - active,
    state.definition.maxConcurrentWorkers - state.tasks.filter(task => BUSY.has(task.status)).length);
  const wake = workflowDigest(available.map(item => ({id:item.id,generation:item.generation})));
  try {
    for (const member of pool.members) {
      if (slots <= 0) break;
      const prior = taskById(state, member.taskId);
      if (member.disabled || prior && BUSY.has(prior.status)) continue;
      const deliver = hasMessages(member.name);
      const retry = member.retryPending && prior;
      if (!deliver && !(retry && prior.inputMessageIds?.length) && (workSlots <= 0 || member.lastWake === wake)) continue;
      if (state.script.calls.length >= state.script.maxCalls || (!member.retryPending && (pool.turns.length >= pool.maxTurns || additionalTurnsAllowed <= 0))) {
        if (!tasks().some(task => task && BUSY.has(task.status))) fail('Consumer turn budget reached; review progress and continue in a new workflow');
        break;
      }
      const key = member.retryPending && prior ? prior.scriptKey! : `@consumer/${pool.id}/${pool.turns.length}`;
      const call = {key,member:member.name,prompt:member.retryPending && prior ? readText(state, prior.objective) : pool.prompt,
        ...(member.workflowTool ? {workflowTool:true} : {}),
        output:'text' as const,selection:{agentKind:member.execution.agentKind,...member.execution.modelSettings}};
      if (deliver && !retry) receiveMessages(state, member.name, key + '/inbox');
      const { task } = scheduleMemberTurn(state, call, member.execution, nativeIdKind(member.execution.agentKind));
      if (!retry && deliver && workSlots <= 0 && !task.consumerMessageTurn) record({ type: 'task_message_turn_marked', taskId: task.taskId });
      const counted = !member.retryPending;
      record({ type: 'pool_turn_scheduled', poolId: pool.id, member: member.name, key, taskId: task.taskId, retry: !counted, wake });
      if (counted) additionalTurnsAllowed--;
      record({ type: 'script_call_recorded', call: { key, taskId: task.taskId, cached: false } });
      slots--; if (!task.consumerMessageTurn) workSlots--;
    }
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  if (pool.status !== 'failed') {
    const busy = tasks().some(task => task && BUSY.has(task.status));
    if (!busy && (available.length || messagesPending) && !state.tasks.some(task => BUSY.has(task.status))) fail('No consumer made progress on available work or messages; inspect member failures and explicitly replay');
    else setStatus(busy ? 'running' : 'waiting', busy ? undefined : unfinishedWork(state, name) ? 'Waiting for dependencies/claim/resource availability' : 'Waiting for new work or queue closure');
  }
  return changed;
}
