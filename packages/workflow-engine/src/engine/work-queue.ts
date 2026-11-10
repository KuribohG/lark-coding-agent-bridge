import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { byId } from './evolve';
import { emit } from './kernel-store';
import { boundedInteger, scriptText } from './script-contract';
import { memberPool, queueControl, queueName, queueNames } from './work-routing';
import type { Immutable, TaskView, WorkClaim, WorkflowView, WorkflowWorkItem } from './types';

type ItemView = Immutable<WorkflowWorkItem>;
type ClaimView = Immutable<WorkClaim>;

export const WORK_MUTATIONS = ['claim_work', 'renew_claim', 'checkpoint_work', 'complete_work', 'fail_work', 'release_claim'];
const MAX_ITEMS = 256;
const MAX_CLAIMS = 512;
const MAX_OPERATIONS = 2048;

function json(value: unknown, name: string): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length > 16_000) throw new Error(`${name} exceeds 16000 characters`);
  return JSON.parse(text);
}

function options(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported work queue option');
}

function capacity(state: WorkflowView): void {
  if (state.workQueue && Buffer.byteLength(JSON.stringify(state.workQueue)) > 2_000_000) throw new Error('Work queue exceeds 2000000 bytes');
}

function itemById(state: WorkflowView, value: unknown): ItemView {
  const item = byId(state.workQueue?.items ?? [], found => found.id, scriptText(value, 'itemId', 100));
  if (!item) throw new Error('Unknown work item');
  return item;
}

/** Creates the named queue (and the queue state itself) when it does not exist yet. */
export function openQueue(state: WorkflowView, name: string): void {
  queueName(name);
  const work = state.workQueue;
  if (work && (name === 'default' || Object.hasOwn(work.queues ?? {}, name))) return;
  if (name !== 'default' && queueNames(state).length >= 16) throw new Error('Work queue limit reached');
  emit(state, { type: 'work_queue_opened', name });
}

export function enqueueWork(state: WorkflowView, args: Record<string, unknown>, now: number): unknown {
  options(args, ['key', 'title', 'input', 'resources', 'maxAttempts', 'queue', 'priority', 'dependsOn']);
  const key = scriptText(args.key, 'work key', 160);
  if (key.trim() !== key) throw new Error('Work key must not contain surrounding whitespace');
  const title = scriptText(args.title, 'work title', 500);
  const input = json(args.input, 'Work input');
  const maxAttempts = boundedInteger(args.maxAttempts, 3, 1, 32);
  const supplied = args.resources ?? [];
  if (!Array.isArray(supplied) || supplied.length > 16) throw new Error('Work resources must be an array of at most 16 keys');
  const resources = [...new Set(supplied.map(value => scriptText(value, 'resource key', 200)))].sort();
  if (resources.some(resource => resource.trim() !== resource)) throw new Error('Resource keys must not contain surrounding whitespace');
  const name = queueName(args.queue);
  const priority = boundedInteger(args.priority, 0, -100, 100);
  const dependencies = args.dependsOn ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 32) throw new Error('dependsOn must contain at most 32 existing work keys');
  const dependsOn = [...new Set(dependencies.map(value => scriptText(value, 'dependency key', 160)))].sort();
  const routing = { ...(name !== 'default' ? { queue: name } : {}), ...(priority ? { priority } : {}), ...(dependsOn.length ? { dependsOn } : {}) };
  const digest = workflowDigest({ key, title, input, maxAttempts, resources, ...routing });
  const items = state.workQueue?.items ?? [];
  const prior = items.find(item => item.key === key);
  if (prior) {
    if (prior.digest !== digest) throw new Error('Work key conflict: input is immutable across replay');
    return { itemId: prior.id, key };
  }
  if (dependsOn.some(dependency => !items.some(item => item.key === dependency))) throw new Error('Dependencies must reference existing work keys; enqueue prerequisites first');
  if (queueControl(state, name)?.closedAt !== undefined) throw new Error('Work queue is closed; new items cannot be enqueued');
  if (items.length >= MAX_ITEMS) throw new Error('Work item limit reached');
  openQueue(state, name);
  const item: WorkflowWorkItem = { id: randomUUID(), key, title, input, digest, maxAttempts, resources, ...routing,
    generation: 0, status: 'pending', progress: { version: 0, state: null }, createdAt: now, updatedAt: now };
  emit(state, { type: 'work_enqueued', item });
  capacity(state);
  return { itemId: item.id, key };
}

export function retryWork(state: WorkflowView, args: Record<string, unknown>, now: number): unknown {
  options(args, ['itemId', 'additionalAttempts']);
  const item = itemById(state, args.itemId);
  if (item.status !== 'failed') throw new Error('Only failed work items can be retried');
  const attempts = boundedInteger(args.additionalAttempts, 1, 1, 8);
  if (item.generation + attempts > 32) throw new Error('Work item attempt limit reached');
  emit(state, { type: 'work_retried', itemId: item.id, maxAttempts: Math.max(item.maxAttempts, item.generation + attempts), at: now });
  return { itemId: item.id, status: item.status, maxAttempts: item.maxAttempts };
}

function endClaim(state: WorkflowView, claim: ClaimView, now: number,
  status: Exclude<WorkClaim['status'], 'active' | 'completed'>, reason: string, retry: boolean): void {
  emit(state, { type: 'claim_ended', claimId: claim.id, status, reason: reason.slice(0, 1000), retry, at: now });
}

/** The kernel also cancels these attempt-bound turns before scheduling replacements. */
export function expireWorkClaims(state: WorkflowView, now: number): ClaimView[] {
  const expired = state.workQueue?.claims.filter(claim => claim.status === 'active' && claim.leaseUntil <= now) ?? [];
  for (const claim of expired) endClaim(state, claim, now, 'expired', 'Claim lease expired', true);
  return expired;
}

export function releaseWorkClaims(state: WorkflowView, now: number, reason: string, taskId?: string, attemptId?: string): void {
  for (const claim of state.workQueue?.claims ?? []) {
    if (claim.status === 'active' && (!taskId || claim.taskId === taskId) && (!attemptId || claim.attemptId === attemptId)) {
      endClaim(state, claim, now, 'cancelled', reason, true);
    }
  }
}

export function cancelWork(state: WorkflowView, now: number): void {
  const unfinished = state.workQueue?.items.filter(item => item.status === 'pending' || item.status === 'claimed') ?? [];
  releaseWorkClaims(state, now, 'Workflow cancelled');
  if (unfinished.length) emit(state, { type: 'work_cancelled', itemIds: unfinished.map(item => item.id), at: now });
}

export function unfinishedWork(state: WorkflowView, name?: string): boolean {
  return state.workQueue?.items.some(item => (name === undefined || (item.queue ?? 'default') === name)
    && (item.status === 'pending' || item.status === 'claimed')) ?? false;
}

/** Closes a queue to new items. `closeKey` pins the script call that closed it across replays. */
export function closeWorkQueue(state: WorkflowView, now: number, name = 'default', closeKey?: string): unknown {
  openQueue(state, name);
  const control = queueControl(state, name)!;
  if (control.closedAt === undefined || closeKey !== undefined && control.closeKey !== closeKey) {
    emit(state, { type: 'work_queue_closed', name, at: now, ...(closeKey !== undefined ? { closeKey } : {}) });
  }
  return { closed: true, closedAt: queueControl(state, name)!.closedAt };
}

/** A conservative dispatch capacity: occupied keys and overlapping pending work consume one slot. */
export function availableWork(state: WorkflowView, name?: string): ItemView[] {
  const items = state.workQueue?.items ?? [];
  const occupied = new Set(items.filter(item => item.status === 'claimed').flatMap(item => item.resources));
  const available: ItemView[] = [];
  for (const item of [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
    if (name !== undefined && (item.queue ?? 'default') !== name) continue;
    if (item.dependsOn?.some(key => !items.some(dependency => dependency.key === key && dependency.status === 'completed'))) continue;
    if (item.status !== 'pending' || item.generation >= item.maxAttempts || item.resources.some(key => occupied.has(key))) continue;
    available.push(item);
    for (const key of item.resources) occupied.add(key);
  }
  return available;
}

export function workStatus(state: WorkflowView, args: Record<string, unknown> = {}): unknown {
  options(args, ['itemId', 'offset', 'limit', 'queue']);
  const name = args.queue === undefined ? undefined : queueName(args.queue);
  if (args.itemId !== undefined) {
    const item = itemById(state, args.itemId);
    if (name !== undefined && (item.queue ?? 'default') !== name) throw new Error('Work item belongs to another queue');
    return { ...item, digest: undefined, claim: state.workQueue?.claims.find(claim => claim.id === item.claimId) };
  }
  const items = (state.workQueue?.items ?? []).filter(item => name === undefined || (item.queue ?? 'default') === name);
  const offset = boundedInteger(args.offset, 0, 0, MAX_ITEMS);
  const limit = boundedInteger(args.limit, 16, 1, 64);
  const counts = { pending: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of items) counts[item.status]++;
  const controls = (name === undefined ? queueNames(state) : [name]).map(name => queueControl(state, name));
  return { total: items.length, ...counts, closed: controls.every(control => control?.closedAt !== undefined),
    closedAt: name === undefined ? state.workQueue?.closedAt : queueControl(state, name)?.closedAt,
    offset, nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit).map(item => ({
    itemId: item.id, key: item.key, queue: item.queue ?? 'default', priority: item.priority ?? 0, dependsOn: item.dependsOn ?? [], title: item.title.slice(0, 120), status: item.status,
    generation: item.generation, maxAttempts: item.maxAttempts, progressVersion: item.progress.version,
    claim: state.workQueue?.claims.find(claim => claim.id === item.claimId),
    error: item.error?.slice(0, 180),
  })) };
}

function ownedClaim(state: WorkflowView, task: TaskView, attemptId: string, args: Record<string, unknown>, now: number): ClaimView {
  const id = scriptText(args.claimId, 'claimId', 100);
  const claim = state.workQueue?.claims.find(claim => claim.id === id);
  if (!claim || claim.status !== 'active' || claim.leaseUntil <= now || claim.agentId !== task.agentId
    || claim.taskId !== task.taskId || claim.attemptId !== attemptId || claim.generation !== args.generation) {
    throw new Error('Claim is stale, expired or belongs to another execution attempt');
  }
  const item = itemById(state, claim.itemId);
  if (item.claimId !== claim.id || item.generation !== claim.generation || item.status !== 'claimed') throw new Error('Claim no longer owns this work item');
  return claim;
}

export function workContext(state: WorkflowView, task: TaskView): unknown {
  const claim = state.workQueue?.claims.find(claim => claim.status === 'active' && claim.taskId === task.taskId);
  const pool = memberPool(state, state.agents?.find(agent => agent.agentId === task.agentId)?.key);
  return state.workQueue ? { total: state.workQueue.items.length, queue: pool?.queue ?? 'default',
    claim: claim ? { ...claim, item: workStatus(state, { itemId: claim.itemId }) } : null } : undefined;
}

/** Called synchronously after kernel authorization and lease expiry handling. */
export function mutateWork(state: WorkflowView, task: TaskView, attemptId: string,
  method: string, args: Record<string, unknown>, now: number): unknown {
  if (!task.agentId) throw new Error('Work claims require a persistent member');
  const allowed: Record<string, string[]> = {
    claim_work: ['leaseMs', 'queue'], renew_claim: ['leaseMs'], checkpoint_work: ['expectedProgressVersion', 'state'],
    complete_work: ['result'], fail_work: ['error', 'retry'], release_claim: ['reason'],
  };
  if (!allowed[method]) throw new Error('Unknown work queue mutation');
  options(args, ['operationId', ...(method === 'claim_work' ? [] : ['claimId', 'generation']), ...allowed[method]!]);
  const operationId = scriptText(args.operationId, 'operationId', 160);
  const key = `${task.taskId}:${attemptId}:${operationId}`;
  const digest = workflowDigest({ method, args });
  const operations = state.workQueue?.operations ?? [];
  const prior = operations.find(operation => operation.key === key);
  const present = (response: unknown) => {
    if (method !== 'claim_work' || response === null) return response;
    const claim = ownedClaim(state, task, attemptId, response as Record<string, unknown>, now);
    return { claimId: claim.id, generation: claim.generation, leaseUntil: claim.leaseUntil,
      item: workStatus(state, { itemId: claim.itemId }) };
  };
  if (prior) {
    if (prior.digest !== digest) throw new Error('operationId conflict: same ID with different work operation');
    return present(prior.response);
  }
  if (operations.length >= MAX_OPERATIONS) throw new Error('Work operation limit reached');
  let response: unknown;
  if (method === 'claim_work') {
    const leaseMs = boundedInteger(args.leaseMs, 120_000, 1000, 300_000);
    const pool = memberPool(state, state.agents?.find(agent => agent.agentId === task.agentId)?.key);
    const name = queueName(args.queue ?? pool?.queue);
    if (pool && name !== (pool.queue ?? 'default')) throw new Error('Consumer cannot claim from another pool queue');
    const claims = state.workQueue?.claims ?? [];
    const held = claims.find(claim => claim.status === 'active' && claim.agentId === task.agentId);
    if (held && (held.taskId !== task.taskId || held.attemptId !== attemptId)) throw new Error('Member has a claim in another attempt');
    if (held && (itemById(state, held.itemId).queue ?? 'default') !== name) throw new Error('Member already has a claim in another queue');
    let claim: Pick<WorkClaim, 'id' | 'generation'> | undefined = held;
    if (!claim) {
      const item = availableWork(state, name)[0];
      if (item) {
        if (claims.length >= MAX_CLAIMS) throw new Error('Work claim history limit reached');
        const granted: WorkClaim = { id: randomUUID(), itemId: item.id, agentId: task.agentId, taskId: task.taskId, attemptId,
          generation: item.generation + 1, leaseUntil: Math.min(now + leaseMs, state.deadlineAt), status: 'active', createdAt: now };
        emit(state, { type: 'work_claimed', claim: granted });
        claim = granted;
      }
    }
    response = claim ? { claimId: claim.id, generation: claim.generation } : null;
    if (!claim && pool) {
      // Another queue may have won the resource after dispatch. An empty claim is not a stalled turn.
      const consumer = pool.members.find(member => member.taskId === task.taskId);
      if (consumer?.lastWake !== undefined) emit(state, { type: 'pool_member_wake_cleared', poolId: pool.id, member: consumer.name });
    }
  } else {
    const claim = ownedClaim(state, task, attemptId, args, now);
    const item = itemById(state, claim.itemId);
    switch (method) {
      case 'renew_claim':
        emit(state, { type: 'claim_renewed', claimId: claim.id,
          leaseUntil: Math.min(Math.max(claim.leaseUntil, now + boundedInteger(args.leaseMs, 120_000, 1000, 300_000)), state.deadlineAt) });
        response = { claimId: claim.id, generation: claim.generation, leaseUntil: claim.leaseUntil };
        break;
      case 'checkpoint_work':
        if (!Object.hasOwn(args, 'state')) throw new Error('Work progress requires state');
        if (args.expectedProgressVersion !== item.progress.version) throw new Error('progressVersion conflict; read work_status before updating');
        emit(state, { type: 'work_progress_saved', itemId: item.id, state: json(args.state, 'Work progress'), at: now });
        response = { itemId: item.id, progressVersion: item.progress.version };
        break;
      case 'complete_work':
        if (!Object.hasOwn(args, 'result')) throw new Error('Work completion requires result');
        emit(state, { type: 'work_completed', claimId: claim.id, result: json(args.result, 'Work result'), at: now });
        response = { itemId: item.id, status: item.status, generation: item.generation };
        break;
      case 'fail_work': {
        if (args.retry !== undefined && typeof args.retry !== 'boolean') throw new Error('retry must be boolean');
        endClaim(state, claim, now, 'failed', scriptText(args.error, 'work error', 1000), args.retry === true);
        response = { itemId: item.id, status: item.status };
        break;
      }
      case 'release_claim':
        endClaim(state, claim, now, 'released', scriptText(args.reason, 'release reason', 1000), true);
        response = { itemId: item.id, status: item.status };
        break;
    }
  }
  emit(state, { type: 'work_operation_recorded', operation: { key, digest, response } });
  capacity(state);
  return present(response);
}
