import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { scheduleMemberTurn } from './durable-agents';
import { boundedInteger, parseScriptAgentCall, scriptText } from './script-contract';
import { availableWork, unfinishedWork, workStatus } from './work-queue';
import type { WorkerExecution, WorkflowState, WorkflowTask } from './types';

const BUSY = new Set<WorkflowTask['status']>(['queued', 'starting', 'running', 'cancelling', 'waiting_workflow']);
const CONSUMER_PROMPT = '\nUse claim_work to consume authorized work. Read item.progress before acting, save checkpoint_work, renew long-running claims, then complete_work or fail_work. Continue until claim_work returns null. Then return a final answer immediately to release your process; the bridge will schedule a new turn when work becomes available. Do not poll or sleep waiting for work. Follow the original goal and declared resource ownership.';

export function parseConsumerPool(input: Record<string, unknown>, state: WorkflowState) {
  if (Object.keys(input).some(key => !['key', 'members', 'prompt', 'maxTurns'].includes(key))) throw new Error('Unsupported consumeWork option');
  const key = scriptText(input.key, 'consumer pool key', 100);
  if (key.trim() !== key) throw new Error('Consumer pool key must not contain surrounding whitespace');
  const prompt = scriptText(input.prompt, 'consumer prompt', 16_000) + CONSUMER_PROMPT;
  const maxTurns = boundedInteger(input.maxTurns, Math.min(32, state.script!.maxCalls), 1, 128);
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > 16) throw new Error('Consumer pool needs 1–16 members');
  const members = input.members.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid consumer member');
    const { name, ...options } = value as Record<string, unknown>;
    if (Object.keys(options).some(key => !['harness', 'model', 'reasoningEffort', 'workflowTool'].includes(key))) throw new Error('Unsupported consumer member option');
    return parseScriptAgentCall({ ...options, key, member: scriptText(name, 'consumer name', 100), prompt }, state.script!.defaults, state.root);
  });
  if (new Set(members.map(member => member.member)).size !== members.length) throw new Error('Consumer member names must be unique');
  return { key, prompt, maxTurns, members };
}

/** Called after resolving and validating every member's current authorized execution binding. */
export function bindConsumerPool(state: WorkflowState, spec: ReturnType<typeof parseConsumerPool>, executions: WorkerExecution[]): void {
  const digest = workflowDigest({ spec, executions });
  let pool = state.consumerPool;
  if (pool) {
    if (pool.key !== spec.key || pool.digest !== digest) throw new Error('Consumer pool definition changed; its key, inputs and member bindings are immutable across replay');
    if (pool.runId === state.script!.runId) throw new Error('Duplicate consumer pool call');
  } else {
    if (state.agents?.some(agent => spec.members.some(member => member.member === agent.key))) throw new Error('Consumer pool requires dedicated member names not already used by agent()');
    pool = state.consumerPool = { id: randomUUID(), key: spec.key, digest, runId: state.script!.runId,
      prompt: spec.prompt, maxTurns: spec.maxTurns, status: 'waiting', turns: [],
      members: spec.members.map((member, index) => ({ name: member.member!, execution: executions[index]!, ...(member.workflowTool ? {workflowTool:true} : {}) })) };
  }
  // Reconstruct each member's committed predecessor chain without replaying its completed turns.
  const completed = pool.turns.filter(turn => state.tasks.find(task => task.taskId === turn.taskId)?.status === 'result_ready');
  if (state.script!.calls.length + completed.length > state.script!.maxCalls) throw new Error('Script agent call limit reached');
  for (const turn of completed) state.script!.calls.push({key:turn.key,taskId:turn.taskId,cached:true});
  for (const member of pool.members) {
    const task = state.tasks.find(task => task.taskId === member.taskId);
    member.retryPending = Boolean(task && task.status !== 'result_ready');
    member.disabled = undefined;
    member.lastWake = undefined;
  }
  pool.runId = state.script!.runId;
  pool.status = 'waiting'; pool.reason = undefined;
  state.workQueue ??= {items:[],claims:[],operations:[]};
}

export function consumerSummary(state: WorkflowState): unknown {
  const pool = state.consumerPool;
  if (!pool) return undefined;
  return { key: pool.key, status: pool.status, reason: pool.reason, turns: pool.turns.length, maxTurns: pool.maxTurns,
    members: pool.members.map(member => ({ name: member.name, taskId: member.taskId, retryPending: member.retryPending,
      status: member.disabled ? 'disabled' : BUSY.has(state.tasks.find(task => task.taskId === member.taskId)?.status ?? 'result_ready') ? 'running' : pool.status === 'drained' ? 'done' : 'waiting',
      reason: member.disabled })) };
}

export function consumerResult(state: WorkflowState): unknown | undefined {
  const pool = state.consumerPool!;
  if (pool.status === 'failed') throw new Error(pool.reason ?? 'Consumer pool failed');
  if (pool.status === 'drained') return { queue: workStatus(state), consumers: consumerSummary(state) };
  return undefined;
}

/** Synchronous queue reconciliation under the kernel's single-writer state boundary. */
export function pumpConsumerPool(state: WorkflowState, additionalTurnsAllowed = Infinity): boolean {
  const pool = state.consumerPool;
  if (!pool || pool.runId !== state.script?.runId || state.status !== 'active' || state.script?.status !== 'running'
    || !['waiting', 'running'].includes(pool.status)) return false;
  const before = JSON.stringify(pool);
  const tasks = () => pool.members.map(member => state.tasks.find(task => task.taskId === member.taskId));
  for (const member of pool.members) {
    const task = state.tasks.find(task => task.taskId === member.taskId);
    if (task && !BUSY.has(task.status) && task.status !== 'result_ready' && !member.retryPending) {
      member.disabled = task.error ?? `Consumer turn is ${task.status}; explicitly replay to retry it`;
    }
  }
  const active = tasks().filter(task => task && BUSY.has(task.status)).length;
  const fail = (reason: string) => { pool.status = 'failed'; pool.reason = reason; };
  if (state.workQueue?.items.some(item => item.status === 'failed')) {
    if (active) pool.status = 'running';
    else fail('Work items failed; inspect /workflow work, retry the failed items, then explicitly replay');
    return before !== JSON.stringify(pool);
  }
  if (!unfinishedWork(state) && !active && state.workQueue?.closedAt !== undefined) {
    pool.status = 'drained'; pool.reason = undefined;
    return before !== JSON.stringify(pool);
  }
  const available = availableWork(state);
  // A queued/running turn which has not claimed yet already represents demand for one item.
  const unclaimed = tasks().filter(task => task && BUSY.has(task.status)
    && !state.workQueue?.claims.some(claim => claim.taskId === task.taskId && claim.status === 'active')).length;
  let slots = Math.min(available.length - unclaimed,
    state.definition.maxConcurrentWorkers - state.tasks.filter(task => BUSY.has(task.status)).length);
  const wake = workflowDigest(available.map(item => ({id:item.id,generation:item.generation})));
  try {
    for (const member of pool.members) {
      if (slots <= 0) break;
      const prior = state.tasks.find(task => task.taskId === member.taskId);
      if (member.disabled || prior && BUSY.has(prior.status) || member.lastWake === wake) continue;
      if (state.script.calls.length >= state.script.maxCalls || (!member.retryPending && (pool.turns.length >= pool.maxTurns || additionalTurnsAllowed <= 0))) {
        if (!tasks().some(task => task && BUSY.has(task.status))) fail('Consumer turn budget reached; review progress and continue in a new workflow');
        break;
      }
      const key = member.retryPending && prior ? prior.scriptKey! : `@consumer/${pool.id}/${pool.turns.length}`;
      const call = {key,member:member.name,prompt:member.retryPending && prior ? prior.objective : pool.prompt,
        ...(member.workflowTool ? {workflowTool:true} : {}),
        output:'text' as const,selection:{agentKind:member.execution.agentKind,...member.execution.modelSettings}};
      const { task } = scheduleMemberTurn(state, call, member.execution);
      if (!member.retryPending) { pool.turns.push({key,member:member.name,taskId:task.taskId}); additionalTurnsAllowed--; }
      state.script.calls.push({key,taskId:task.taskId,cached:false});
      member.taskId = task.taskId; member.retryPending = false; member.lastWake = wake;
      slots--;
    }
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  if (pool.status !== 'failed') {
    const busy = tasks().some(task => task && BUSY.has(task.status));
    if (!busy && available.length && !state.tasks.some(task => BUSY.has(task.status))) fail('No consumer made progress on available work; inspect member failures and explicitly replay');
    else {
      pool.status = busy ? 'running' : 'waiting';
      pool.reason = busy ? undefined : unfinishedWork(state) ? 'Waiting for claim/resource availability' : 'Waiting for new work or queue closure';
    }
  }
  return before !== JSON.stringify(pool);
}
