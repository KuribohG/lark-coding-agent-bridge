import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { boundedInteger, scriptText } from './script-contract';
import type { WorkClaim, WorkflowState, WorkflowTask, WorkflowWorkItem, WorkflowWorkQueue } from './types';

export const WORK_MUTATIONS = ['claim_work', 'renew_claim', 'checkpoint_work', 'complete_work', 'fail_work', 'release_claim'];
const MAX_ITEMS = 256;
const MAX_CLAIMS = 512;
const MAX_OPERATIONS = 2048;

function queue(state: WorkflowState): WorkflowWorkQueue {
  return state.workQueue ??= { items: [], claims: [], operations: [] };
}

function json(value: unknown, name: string): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length > 16_000) throw new Error(`${name} exceeds 16000 characters`);
  return JSON.parse(text);
}

function options(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported work queue option');
}

function capacity(work: WorkflowWorkQueue): void {
  if (Buffer.byteLength(JSON.stringify(work)) > 2_000_000) throw new Error('Work queue exceeds 2000000 bytes');
}

function itemById(state: WorkflowState, value: unknown): WorkflowWorkItem {
  const id = scriptText(value, 'itemId', 100);
  const item = state.workQueue?.items.find(item => item.id === id);
  if (!item) throw new Error('Unknown work item');
  return item;
}

export function enqueueWork(state: WorkflowState, args: Record<string, unknown>, now: number): unknown {
  options(args, ['key', 'title', 'input', 'resources', 'maxAttempts']);
  const key = scriptText(args.key, 'work key', 160);
  if (key.trim() !== key) throw new Error('Work key must not contain surrounding whitespace');
  const title = scriptText(args.title, 'work title', 500);
  const input = json(args.input, 'Work input');
  const maxAttempts = boundedInteger(args.maxAttempts, 3, 1, 32);
  const supplied = args.resources ?? [];
  if (!Array.isArray(supplied) || supplied.length > 16) throw new Error('Work resources must be an array of at most 16 keys');
  const resources = [...new Set(supplied.map(value => scriptText(value, 'resource key', 200)))].sort();
  if (resources.some(resource => resource.trim() !== resource)) throw new Error('Resource keys must not contain surrounding whitespace');
  const digest = workflowDigest({ key, title, input, maxAttempts, resources });
  const work = queue(state);
  const prior = work.items.find(item => item.key === key);
  if (prior) {
    if (prior.digest !== digest) throw new Error('Work key conflict: input is immutable across replay');
    return { itemId: prior.id, key };
  }
  if (work.closedAt !== undefined) throw new Error('Work queue is closed; new items cannot be enqueued');
  if (work.items.length >= MAX_ITEMS) throw new Error('Work item limit reached');
  const item: WorkflowWorkItem = { id: randomUUID(), key, title, input, digest, maxAttempts, resources,
    generation: 0, status: 'pending', progress: { version: 0, state: null }, createdAt: now, updatedAt: now };
  work.items.push(item);
  capacity(work);
  return { itemId: item.id, key };
}

export function retryWork(state: WorkflowState, args: Record<string, unknown>, now: number): unknown {
  options(args, ['itemId', 'additionalAttempts']);
  const item = itemById(state, args.itemId);
  if (item.status !== 'failed') throw new Error('Only failed work items can be retried');
  const attempts = boundedInteger(args.additionalAttempts, 1, 1, 8);
  if (item.generation + attempts > 32) throw new Error('Work item attempt limit reached');
  item.maxAttempts = Math.max(item.maxAttempts, item.generation + attempts);
  item.status = 'pending'; item.error = undefined; item.updatedAt = now;
  return { itemId: item.id, status: item.status, maxAttempts: item.maxAttempts };
}

function endClaim(work: WorkflowWorkQueue, claim: WorkClaim, now: number,
  status: Exclude<WorkClaim['status'], 'active' | 'completed'>, reason: string, retry: boolean): void {
  const item = work.items.find(item => item.id === claim.itemId)!;
  claim.status = status; claim.endedAt = now; claim.reason = reason.slice(0, 1000);
  item.claimId = undefined; item.updatedAt = now; item.error = claim.reason;
  item.status = retry && item.generation < item.maxAttempts ? 'pending' : 'failed';
  if (retry && item.status === 'failed') item.error = 'Attempt budget exhausted: ' + claim.reason;
}

/** The kernel also cancels these attempt-bound turns before scheduling replacements. */
export function expireWorkClaims(state: WorkflowState, now: number): WorkClaim[] {
  const work = state.workQueue;
  const expired = work?.claims.filter(claim => claim.status === 'active' && claim.leaseUntil <= now) ?? [];
  for (const claim of expired) endClaim(work!, claim, now, 'expired', 'Claim lease expired', true);
  return expired;
}

export function releaseWorkClaims(state: WorkflowState, now: number, reason: string, taskId?: string, attemptId?: string): void {
  const work = state.workQueue;
  if (!work) return;
  for (const claim of work.claims) {
    if (claim.status === 'active' && (!taskId || claim.taskId === taskId) && (!attemptId || claim.attemptId === attemptId)) {
      endClaim(work, claim, now, 'cancelled', reason, true);
    }
  }
}

export function cancelWork(state: WorkflowState, now: number): void {
  const unfinished = state.workQueue?.items.filter(item => item.status === 'pending' || item.status === 'claimed') ?? [];
  releaseWorkClaims(state, now, 'Workflow cancelled');
  for (const item of unfinished) {
    item.status = 'cancelled'; item.updatedAt = now;
  }
}

export function unfinishedWork(state: WorkflowState): boolean {
  return state.workQueue?.items.some(item => item.status === 'pending' || item.status === 'claimed') ?? false;
}

export function closeWorkQueue(state: WorkflowState, now: number): unknown {
  const work = queue(state);
  work.closedAt ??= now;
  return { closed: true, closedAt: work.closedAt };
}

/** A conservative dispatch capacity: occupied keys and overlapping pending work consume one slot. */
export function availableWork(state: WorkflowState): WorkflowWorkItem[] {
  const items = state.workQueue?.items ?? [];
  const occupied = new Set(items.filter(item => item.status === 'claimed').flatMap(item => item.resources));
  const available: WorkflowWorkItem[] = [];
  for (const item of items) {
    if (item.status !== 'pending' || item.generation >= item.maxAttempts || item.resources.some(key => occupied.has(key))) continue;
    available.push(item);
    for (const key of item.resources) occupied.add(key);
  }
  return available;
}

export function workStatus(state: WorkflowState, args: Record<string, unknown> = {}): unknown {
  options(args, ['itemId', 'offset', 'limit']);
  if (args.itemId !== undefined) {
    const item = itemById(state, args.itemId);
    return { ...item, digest: undefined, claim: state.workQueue?.claims.find(claim => claim.id === item.claimId) };
  }
  const items = state.workQueue?.items ?? [];
  const offset = boundedInteger(args.offset, 0, 0, MAX_ITEMS);
  const limit = boundedInteger(args.limit, 16, 1, 64);
  const counts = { pending: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of items) counts[item.status]++;
  return { total: items.length, ...counts, closed: state.workQueue?.closedAt !== undefined, closedAt: state.workQueue?.closedAt,
    offset, nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit).map(item => ({
    itemId: item.id, key: item.key, title: item.title.slice(0, 120), status: item.status,
    generation: item.generation, maxAttempts: item.maxAttempts, progressVersion: item.progress.version,
    claim: state.workQueue?.claims.find(claim => claim.id === item.claimId),
    error: item.error?.slice(0, 180),
  })) };
}

function ownedClaim(state: WorkflowState, task: WorkflowTask, attemptId: string, args: Record<string, unknown>, now: number): WorkClaim {
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

export function workContext(state: WorkflowState, task: WorkflowTask): unknown {
  const claim = state.workQueue?.claims.find(claim => claim.status === 'active' && claim.taskId === task.taskId);
  return state.workQueue ? { total: state.workQueue.items.length,
    claim: claim ? { ...claim, item: workStatus(state, { itemId: claim.itemId }) } : null } : undefined;
}

/** Called synchronously after kernel authorization and lease expiry handling. */
export function mutateWork(state: WorkflowState, task: WorkflowTask, attemptId: string,
  method: string, args: Record<string, unknown>, now: number): unknown {
  if (!task.agentId) throw new Error('Work claims require a persistent member');
  const allowed: Record<string, string[]> = {
    claim_work: ['leaseMs'], renew_claim: ['leaseMs'], checkpoint_work: ['expectedProgressVersion', 'state'],
    complete_work: ['result'], fail_work: ['error', 'retry'], release_claim: ['reason'],
  };
  if (!allowed[method]) throw new Error('Unknown work queue mutation');
  options(args, ['operationId', ...(method === 'claim_work' ? [] : ['claimId', 'generation']), ...allowed[method]!]);
  const operationId = scriptText(args.operationId, 'operationId', 160);
  const work = queue(state);
  const key = `${task.taskId}:${attemptId}:${operationId}`;
  const digest = workflowDigest({ method, args });
  const prior = work.operations.find(operation => operation.key === key);
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
  if (work.operations.length >= MAX_OPERATIONS) throw new Error('Work operation limit reached');
  let response: unknown;
  if (method === 'claim_work') {
    const leaseMs = boundedInteger(args.leaseMs, 120_000, 1000, 300_000);
    let claim = work.claims.find(claim => claim.status === 'active' && claim.agentId === task.agentId);
    if (claim && (claim.taskId !== task.taskId || claim.attemptId !== attemptId)) throw new Error('Member has a claim in another attempt');
    if (!claim) {
      const occupied = new Set(work.items.filter(item => item.status === 'claimed').flatMap(item => item.resources));
      const item = work.items.find(item => item.status === 'pending' && item.generation < item.maxAttempts
        && !item.resources.some(resource => occupied.has(resource)));
      if (item) {
        if (work.claims.length >= MAX_CLAIMS) throw new Error('Work claim history limit reached');
        claim = { id: randomUUID(), itemId: item.id, agentId: task.agentId, taskId: task.taskId, attemptId,
          generation: ++item.generation, leaseUntil: Math.min(now + leaseMs, state.deadlineAt), status: 'active', createdAt: now };
        work.claims.push(claim);
        item.claimId = claim.id; item.status = 'claimed'; item.updatedAt = now; item.error = undefined;
      }
    }
    response = claim ? { claimId: claim.id, generation: claim.generation } : null;
  } else {
    const claim = ownedClaim(state, task, attemptId, args, now);
    const item = itemById(state, claim.itemId);
    switch (method) {
      case 'renew_claim':
        claim.leaseUntil = Math.min(Math.max(claim.leaseUntil, now + boundedInteger(args.leaseMs, 120_000, 1000, 300_000)), state.deadlineAt);
        response = { claimId: claim.id, generation: claim.generation, leaseUntil: claim.leaseUntil };
        break;
      case 'checkpoint_work':
        if (!Object.hasOwn(args, 'state')) throw new Error('Work progress requires state');
        if (args.expectedProgressVersion !== item.progress.version) throw new Error('progressVersion conflict; read work_status before updating');
        item.progress = { version: item.progress.version + 1, state: json(args.state, 'Work progress'), updatedAt: now };
        item.updatedAt = now;
        response = { itemId: item.id, progressVersion: item.progress.version };
        break;
      case 'complete_work':
        if (!Object.hasOwn(args, 'result')) throw new Error('Work completion requires result');
        item.result = json(args.result, 'Work result'); item.status = 'completed'; item.updatedAt = now; item.claimId = undefined; item.error = undefined;
        claim.status = 'completed'; claim.endedAt = now;
        response = { itemId: item.id, status: item.status, generation: item.generation };
        break;
      case 'fail_work': {
        if (args.retry !== undefined && typeof args.retry !== 'boolean') throw new Error('retry must be boolean');
        endClaim(work, claim, now, 'failed', scriptText(args.error, 'work error', 1000), args.retry === true);
        response = { itemId: item.id, status: item.status };
        break;
      }
      case 'release_claim':
        endClaim(work, claim, now, 'released', scriptText(args.reason, 'release reason', 1000), true);
        response = { itemId: item.id, status: item.status };
        break;
    }
  }
  work.operations.push({ key, digest, response });
  capacity(work);
  return present(response);
}
