import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { byId } from './evolve';
import { archivedRecord, workItemByKey, workOperationByKey } from './kernel-state';
import { emit, recordsOf } from './kernel-store';
import { WORK_FLOW_SLOT_MS, WORK_FLOW_SLOTS, WORK_MAX_BYTES, WORK_MAX_CLAIMS, WORK_MAX_ITEMS, WORK_MAX_OPERATIONS } from './limits';
import { boundedInteger, scriptText } from './script-contract';
import { matchFields, SEARCH_ARCHIVE_ROWS, searchTerms, searchText, storedTerms } from './search';
import { consumes, MEMBER_NAME, memberQueue, queueControl, queueName, queueNames } from './work-routing';
import type { Immutable, TaskView, WorkClaim, WorkflowView, WorkflowWorkItem } from './types';

type ItemView = Immutable<WorkflowWorkItem>;
type ClaimView = Immutable<WorkClaim>;

export const WORK_MUTATIONS = ['claim_work', 'checkpoint_work', 'complete_work', 'fail_work', 'release_claim'];

function json(value: unknown, name: string): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length > 16_000) throw new Error(`${name} exceeds 16000 characters`);
  return JSON.parse(text);
}

function options(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported work queue option');
}

/** Upper estimates of each workflow's serialized queue size, so the exact size is measured only near the limit. */
const queueBytes = new WeakMap<object, number>();

/**
 * Enforces WORK_MAX_BYTES after a change that added at most the serialized size of `added`. Serializing the whole
 * queue on every change costs time in its size; the estimate only grows, and is corrected by an exact measurement
 * whenever it reaches the limit, so the verdict is always that of the exact size.
 */
function capacity(state: WorkflowView, ...added: unknown[]): void {
  const queue = state.workQueue;
  if (!queue) return;
  const exact = () => Buffer.byteLength(JSON.stringify(queue));
  const prior = queueBytes.get(queue);
  let bytes = prior === undefined ? exact() : prior + 1024 + added.reduce((total: number, value) => total + 3 * JSON.stringify(value ?? null).length, 0);
  if (prior !== undefined && bytes > WORK_MAX_BYTES) bytes = exact();
  queueBytes.set(queue, bytes);
  if (bytes > WORK_MAX_BYTES) throw new Error(`Work queue exceeds ${WORK_MAX_BYTES} bytes`);
}

function itemById(state: WorkflowView, value: unknown): ItemView {
  const id = scriptText(value, 'itemId', 100);
  // An archived item is completed or cancelled and will not change.
  const item = byId(state.workQueue?.items ?? [], found => found.id, id) ?? archivedRecord<WorkflowWorkItem>(state, 'workItem', { id });
  if (!item) throw new Error('Unknown work item');
  return item;
}

/** An item by its ID, whether it is still in the state or archived. */
export function workItem(state: WorkflowView, id: string): ItemView | undefined {
  return byId(state.workQueue?.items ?? [], found => found.id, id) ?? archivedRecord<WorkflowWorkItem>(state, 'workItem', { id });
}

/** The item a request names, by its ID or by its key. */
function itemOf(state: WorkflowView, args: Record<string, unknown>): ItemView {
  if ((args.itemId === undefined) === (args.key === undefined)) throw new Error('Name the work item by itemId or by key');
  if (args.itemId !== undefined) return itemById(state, args.itemId);
  const item = workItemByKey(state, scriptText(args.key, 'work key', 160));
  if (!item) throw new Error('Unknown work item');
  return item;
}

/**
 * What a caller may do to an item: `plans` for whoever plans its queue (the main agent, the swarm's lead, the lead of
 * the queue), `added` for the member that added it, which may only withdraw it.
 */
export type WorkAuthority = (item: ItemView) => 'plans' | 'added' | undefined;

/** Creates the named queue (and the queue state itself) when it does not exist yet. */
export function openQueue(state: WorkflowView, name: string): void {
  queueName(name);
  const work = state.workQueue;
  if (work && (name === 'default' || Object.hasOwn(work.queues ?? {}, name))) return;
  if (name !== 'default' && queueNames(state).length >= 16) throw new Error('Work queue limit reached');
  emit(state, { type: 'work_queue_opened', name });
}

/** A path as items are compared by it: no `.` segments, repeated or trailing slashes; `.` is the whole tree. */
function writePath(value: unknown): string {
  const text = scriptText(value, 'write path', 200);
  if (!text || text.trim() !== text) throw new Error('Write paths must not be empty or contain surrounding whitespace');
  const parts = text.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) throw new Error('Write paths must not contain ..');
  return text.startsWith('/') ? '/' + parts.join('/') : parts.join('/') || '.';
}

/** Whether `path` is `tree` or lies under it. Relative and absolute paths never meet. */
const under = (path: string, tree: string) => tree === '.' ? !path.startsWith('/') : tree === '/' ? path.startsWith('/') : path === tree || path.startsWith(tree + '/');

/** The keys an item waits for, directly or through the items it depends on. */
function prerequisites(state: WorkflowView, item: ItemView): Set<string> {
  const found = new Set<string>();
  const open = [...item.dependsOn ?? []];
  while (open.length) {
    const key = open.pop()!;
    if (found.has(key)) continue;
    found.add(key);
    open.push(...workItemByKey(state, key)?.dependsOn ?? []);
  }
  return found;
}

const WRITE_OVERLAPS_SHOWN = 8;

/**
 * The unfinished items that expect to change the same paths as `item` while nothing keeps the two apart: neither
 * waits for the other, and they share no resource key. `writes` is a statement of intent, not a lock. A conflict
 * between two members is otherwise found when the second one lands; reported here, whoever plans the queue can order
 * the items, and whoever claims one knows who else is in those files.
 */
export function writeOverlaps(state: WorkflowView, item: ItemView): { writeOverlaps: unknown[]; moreWriteOverlaps?: number } | undefined {
  if (!item.writes?.length || item.status !== 'pending' && item.status !== 'claimed') return undefined;
  const before = prerequisites(state, item);
  const overlaps = [];
  for (const other of state.workQueue?.items ?? []) {
    if (other.id === item.id || !other.writes?.length || other.status !== 'pending' && other.status !== 'claimed') continue;
    const paths = other.writes.filter(theirs => item.writes!.some(ours => under(theirs, ours) || under(ours, theirs)));
    if (!paths.length || other.resources.some(key => item.resources.includes(key)) || before.has(other.key) || prerequisites(state, other).has(item.key)) continue;
    const claim = other.status === 'claimed' ? state.workQueue!.claims.find(claim => claim.id === other.claimId) : undefined;
    const member = claim && state.agents?.find(agent => agent.agentId === claim.agentId)?.key;
    overlaps.push({ key: other.key, queue: other.queue ?? 'default', status: other.status, ...(member ? { member } : {}), title: other.title.slice(0, 80), paths: paths.slice(0, 4) });
  }
  if (!overlaps.length) return undefined;
  // The ones a member is working on now come first: they are the conflicts that have already begun.
  overlaps.sort((a, b) => Number(b.status === 'claimed') - Number(a.status === 'claimed'));
  return { writeOverlaps: overlaps.slice(0, WRITE_OVERLAPS_SHOWN), ...(overlaps.length > WRITE_OVERLAPS_SHOWN ? { moreWriteOverlaps: overlaps.length - WRITE_OVERLAPS_SHOWN } : {}) };
}

/** A member's name as an item carries it. Whether such a member exists is not checked: a script may name one before its swarm starts. */
function assigneeName(value: unknown): string {
  const name = scriptText(value, 'assignee', 100);
  if (!MEMBER_NAME.test(name)) throw new Error('assignee is the name of a member');
  return name;
}

/** The member holding the item's active claim. */
function holder(state: WorkflowView, item: ItemView): string | undefined {
  const claim = item.status === 'claimed' ? state.workQueue?.claims.find(found => found.id === item.claimId) : undefined;
  return claim && state.agents?.find(agent => agent.agentId === claim.agentId)?.key;
}

/**
 * The member whose work an item's result is: the one that completed it, or the one at work on it now. An item
 * completed before items recorded this is read from its claim, while the claim is still in the state.
 */
function author(state: WorkflowView, item: ItemView): string | undefined {
  if (item.doneBy || item.status !== 'completed') return item.doneBy ?? holder(state, item);
  const claim = state.workQueue?.claims.find(found => found.itemId === item.id && found.status === 'completed');
  return claim && state.agents?.find(agent => agent.agentId === claim.agentId)?.key;
}

/** The member an item is kept for: its assignee, while that member can still take work from the item's queue. */
export function keptFor(state: WorkflowView, item: ItemView): string | undefined {
  return item.assignee && consumes(state, item.assignee, item.queue ?? 'default') ? item.assignee : undefined;
}

/**
 * Whom an unfinished item is for, as a caller is shown it. An assignee that cannot take the item (a name nobody has,
 * a member of another queue, one that has stopped or used its wake-ups) does not keep it from the others, and the
 * caller that named it is told so instead of waiting for that member.
 */
export function assigned(state: WorkflowView, item: ItemView): { assignee?: string; assigneeNote?: string } {
  if (!item.assignee) return {};
  return { assignee: item.assignee, ...(item.status === 'pending' && !keptFor(state, item)
    ? { assigneeNote: `${item.assignee} cannot take it now (it does not consume queue "${item.queue ?? 'default'}", has stopped or has no wake-ups left), so any member of the queue can claim it` } : {}) };
}

export function enqueueWork(state: WorkflowView, args: Record<string, unknown>, now: number, by?: string): unknown {
  options(args, ['key', 'title', 'input', 'resources', 'writes', 'maxAttempts', 'queue', 'priority', 'dependsOn', 'origin', 'assignee']);
  const key = scriptText(args.key, 'work key', 160);
  if (key.trim() !== key) throw new Error('Work key must not contain surrounding whitespace');
  const title = scriptText(args.title, 'work title', 500);
  const input = json(args.input, 'Work input');
  const maxAttempts = boundedInteger(args.maxAttempts, 3, 1, 32);
  const supplied = args.resources ?? [];
  if (!Array.isArray(supplied) || supplied.length > 16) throw new Error('Work resources must be an array of at most 16 keys');
  const resources = [...new Set(supplied.map(value => scriptText(value, 'resource key', 200)))].sort();
  if (resources.some(resource => resource.trim() !== resource)) throw new Error('Resource keys must not contain surrounding whitespace');
  const written = args.writes ?? [];
  if (!Array.isArray(written) || written.length > 16) throw new Error('Work writes must be an array of at most 16 paths');
  const writes = [...new Set(written.map(writePath))].sort();
  const origin = args.origin === undefined ? undefined : scriptText(args.origin, 'origin key', 160);
  const source = origin === undefined ? undefined : workItemByKey(state, origin);
  const named = args.assignee === undefined ? undefined : assigneeName(args.assignee);
  // Work that follows from an item belongs, unless the caller says otherwise, where that item was done.
  const name = queueName(args.queue ?? source?.queue);
  const priority = boundedInteger(args.priority, 0, -100, 100);
  const dependencies = args.dependsOn ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 32) throw new Error('dependsOn must contain at most 32 existing work keys');
  const dependsOn = [...new Set(dependencies.map(value => scriptText(value, 'dependency key', 160)))].sort();
  // Absent when empty, like the others, so that the digest of an item that names none is what it was before items could.
  // The digest holds what the caller named, not the member `origin` resolves to, which a replay may find changed.
  const routing = { ...(name !== 'default' ? { queue: name } : {}), ...(priority ? { priority } : {}), ...(dependsOn.length ? { dependsOn } : {}), ...(writes.length ? { writes } : {}),
    ...(origin !== undefined ? { origin } : {}) };
  const digest = workflowDigest({ key, title, input, maxAttempts, resources, ...routing, ...(named ? { assignee: named } : {}) });
  const items = state.workQueue?.items ?? [];
  const prior = workItemByKey(state, key);
  if (prior) {
    if (prior.digest !== digest) throw new Error('Work key conflict: input is immutable across replay');
    return { itemId: prior.id, key };
  }
  if (origin !== undefined && !source) throw new Error('origin must be the key of an existing work item');
  const assignee = named ?? (source && author(state, source));
  if (dependsOn.some(dependency => !workItemByKey(state, dependency))) throw new Error('Dependencies must reference existing work keys; enqueue prerequisites first');
  if (queueControl(state, name)?.closedAt !== undefined) throw new Error('Work queue is closed; new items cannot be enqueued');
  if (items.length >= WORK_MAX_ITEMS) throw new Error('Work item limit reached');
  openQueue(state, name);
  const item: WorkflowWorkItem = { id: randomUUID(), key, title, ...(by ? { by } : {}), input, digest, maxAttempts, resources, ...routing, ...(assignee ? { assignee } : {}),
    generation: 0, status: 'pending', progress: { version: 0, state: null }, createdAt: now, updatedAt: now };
  emit(state, { type: 'work_enqueued', item });
  capacity(state, item);
  return { itemId: item.id, key };
}

/**
 * A persistent member adds work it found. A key that already exists answers with that item instead of failing, so
 * members that report the same finding do not duplicate it. Members add to queues that exist: by default the queue of
 * the item the work follows from (`origin`), else their own.
 */
export function enqueueFromMember(state: WorkflowView, task: TaskView, args: Record<string, unknown>, now: number): unknown {
  if (!task.agentId) throw new Error('enqueue_work requires a persistent member');
  const member = state.agents?.find(agent => agent.agentId === task.agentId)?.key;
  const { operationId: _operationId, ...input } = args;
  const key = scriptText(input.key, 'work key', 160);
  const prior = workItemByKey(state, key);
  if (prior) return { itemId: prior.id, key, existing: true, status: prior.status, title: prior.title.slice(0, 120) };
  const source = input.origin === undefined ? undefined : workItemByKey(state, scriptText(input.origin, 'origin key', 160));
  const name = queueName(input.queue ?? (source ? source.queue ?? 'default' : memberQueue(state, member)));
  if (!queueNames(state).includes(name)) throw new Error(`Unknown work queue; members add to existing queues: ${queueNames(state).join(', ')}`);
  return enqueueWork(state, { ...input, queue: name }, now, member);
}

export function retryWork(state: WorkflowView, args: Record<string, unknown>, now: number, authority: WorkAuthority = () => 'plans'): unknown {
  options(args, ['itemId', 'key', 'additionalAttempts']);
  const item = itemOf(state, args);
  if (authority(item) !== 'plans') throw new Error('Only the main agent, the swarm lead or the lead of its queue can retry a work item');
  if (item.status !== 'failed') throw new Error('Only failed work items can be retried');
  const attempts = boundedInteger(args.additionalAttempts, 1, 1, 8);
  if (item.generation + attempts > 32) throw new Error('Work item attempt limit reached');
  emit(state, { type: 'work_retried', itemId: item.id, maxAttempts: Math.max(item.maxAttempts, item.generation + attempts), at: now });
  return { itemId: item.id, status: item.status, maxAttempts: item.maxAttempts };
}

/**
 * Changes an item that is not finished, for whoever plans its queue: `priority` moves it in the order items are handed
 * out, `hold` sets it aside (true) or returns it (false), `assignee` gives it to one member (a name) or back to the
 * whole queue (null), `cancel` withdraws it. Work that has become pointless otherwise stays in the queue until a
 * member claims it and gives it up. A claimed item is not cancelled here: its member is at work on it and is the one
 * to stop.
 */
export function updateWork(state: WorkflowView, args: Record<string, unknown>, now: number, authority: WorkAuthority = () => 'plans', by = 'main'): unknown {
  options(args, ['itemId', 'key', 'priority', 'hold', 'assignee', 'cancel', 'reason']);
  const item = itemOf(state, args);
  const may = authority(item);
  if (args.cancel !== undefined && args.cancel !== true) throw new Error('cancel must be true');
  if (args.hold !== undefined && typeof args.hold !== 'boolean') throw new Error('hold must be boolean');
  const changes = args.priority !== undefined || args.hold !== undefined || args.assignee !== undefined;
  if (!changes && !args.cancel) throw new Error('Give priority, hold, assignee or cancel');
  if (changes && args.cancel) throw new Error('cancel withdraws the item; do not combine it with priority, hold or assignee');
  if (args.reason !== undefined && !args.cancel) throw new Error('reason belongs to cancel');
  if (!may || may === 'added' && changes) throw new Error(may ? 'A member can only withdraw (cancel) an item it added; its priority, hold and assignee are for the lead that plans the queue'
    : 'Only the main agent, the swarm lead, the lead of its queue or, to cancel it, the member that added it can change a work item');
  const view = (found: ItemView) => ({ itemId: found.id, key: found.key, queue: found.queue ?? 'default', status: found.status, priority: found.priority ?? 0, ...(found.hold ? { hold: true } : {}), ...assigned(state, found) });
  if (args.cancel) {
    const reason = args.reason === undefined ? undefined : scriptText(args.reason, 'reason', 500).trim() || undefined;
    if (item.status === 'cancelled') return view(item);
    if (item.status === 'completed') throw new Error('Work item is already completed');
    if (item.status === 'claimed') {
      const claim = state.workQueue?.claims.find(found => found.id === item.claimId);
      const member = state.agents?.find(agent => agent.agentId === claim?.agentId)?.key;
      throw new Error(`Work item is claimed${member ? ' by ' + member : ''}; tell that member to stop on the board, and cancel the item once it has returned to the queue`);
    }
    emit(state, { type: 'work_cancelled', itemIds: [item.id], at: now, reason: `Cancelled by ${by}` + (reason ? ': ' + reason : '') });
    // What waited on the item can no longer be claimed; whoever cancelled it decides what becomes of that work.
    const blocks = (state.workQueue?.items ?? []).filter(other => (other.status === 'pending' || other.status === 'failed') && other.dependsOn?.includes(item.key)).map(other => other.key);
    return { ...view(item), ...(blocks.length ? { blocks: blocks.slice(0, 16), ...(blocks.length > 16 ? { moreBlocked: blocks.length - 16 } : {}) } : {}) };
  }
  if (item.status === 'completed' || item.status === 'cancelled') throw new Error(`Work item is already ${item.status}`);
  const priority = args.priority === undefined ? undefined : boundedInteger(args.priority, 0, -100, 100);
  const hold = args.hold as boolean | undefined;
  const assignee = args.assignee === undefined ? undefined : args.assignee === null ? null : assigneeName(args.assignee);
  const changed = { ...(priority !== undefined && priority !== (item.priority ?? 0) ? { priority } : {}), ...(hold !== undefined && hold !== Boolean(item.hold) ? { hold } : {}),
    ...(assignee !== undefined && assignee !== (item.assignee ?? null) ? { assignee } : {}) };
  if (Object.keys(changed).length) emit(state, { type: 'work_updated', itemId: item.id, ...changed, at: now });
  return view(item);
}

function endClaim(state: WorkflowView, claim: ClaimView, now: number,
  status: Exclude<WorkClaim['status'], 'active' | 'completed'>, reason: string, retry: boolean): void {
  emit(state, { type: 'claim_ended', claimId: claim.id, status, reason: reason.slice(0, 1000), retry, at: now });
}

/** A lease the engine extends on a member's behalf lasts this long, so a turn that has gone is noticed within it. */
const HELD_LEASE_MS = 120_000;

/**
 * Settles the claims whose lease has run out. A claim whose turn is still running (`held`) is extended: the member
 * is at work, and whether it has hung is the stall watchdog's call, not something a member must disprove by
 * renewing in time. The others expire; the kernel cancels what is left of their turns.
 */
export function expireWorkClaims(state: WorkflowView, now: number, held: (claim: ClaimView) => boolean = () => false): ClaimView[] {
  const due = state.workQueue?.claims.filter(claim => claim.status === 'active' && !claim.frozen && claim.heldUntil === undefined && claim.leaseUntil <= now) ?? [];
  const expired: ClaimView[] = [];
  for (const claim of due) {
    if (now < state.deadlineAt && held(claim)) emit(state, { type: 'claim_renewed', claimId: claim.id, leaseUntil: Math.min(now + HELD_LEASE_MS, state.deadlineAt) });
    else { endClaim(state, claim, now, 'expired', 'Claim lease expired', true); expired.push(claim); }
  }
  return expired;
}

export function releaseWorkClaims(state: WorkflowView, now: number, reason: string, taskId?: string, attemptId?: string): void {
  for (const claim of state.workQueue?.claims ?? []) {
    if (claim.status === 'active' && (!claim.frozen || attemptId === claim.attemptId)
      && (!taskId || claim.taskId === taskId) && (!attemptId || claim.attemptId === attemptId)) {
      endClaim(state, claim, now, 'cancelled', reason, true);
    }
  }
}

export function freezeWorkClaims(state: WorkflowView, reason: string, taskId?: string): void {
  for (const claim of state.workQueue?.claims ?? []) {
    if (claim.status === 'active' && !claim.frozen && (!taskId || claim.taskId === taskId))
      emit(state, { type: 'claim_frozen', claimId: claim.id, reason });
  }
}

/**
 * A host restart cut short the turns that hold these claims. Each claim stays with its member, which still has the
 * conversation (and often the process) that was doing the work, until that member's next attempt adopts it. A
 * claim nobody adopts by `until` is released like any other abandoned claim.
 */
export function holdWorkClaims(state: WorkflowView, until: number): void {
  for (const claim of state.workQueue?.claims ?? []) {
    if (claim.status === 'active' && !claim.frozen) emit(state, { type: 'claim_held', claimId: claim.id, until });
  }
}

/**
 * Ends the claims a restart left held whose member did not come back in time, and returns them. A held claim has
 * no turn to renew it, so its lease does not count; a member whose next turn is queued is coming back.
 */
export function abandonHeldClaims(state: WorkflowView, now: number): ClaimView[] {
  const abandoned = state.workQueue?.claims.filter(claim => claim.status === 'active' && claim.heldUntil !== undefined && claim.heldUntil <= now
    && !state.tasks.some(task => task.agentId === claim.agentId && task.status === 'queued')) ?? [];
  for (const claim of abandoned) endClaim(state, claim, now, 'cancelled', 'Bridge restarted and the member did not resume its turn', true);
  return abandoned;
}

/** A member's attempt takes over the claim a restart left held for it, with the claim ID and generation it had. */
export function adoptWorkClaims(state: WorkflowView, task: TaskView, attemptId: string, now: number): void {
  if (!task.agentId) return;
  for (const claim of state.workQueue?.claims ?? []) {
    if (claim.status !== 'active' || claim.heldUntil === undefined || claim.agentId !== task.agentId) continue;
    emit(state, { type: 'claim_adopted', claimId: claim.id, by: { taskId: task.taskId, attemptId } });
    // The lease lapsed while no host ran; a renewal, unlike the adoption, is what a replay reads the lease from.
    emit(state, { type: 'claim_renewed', claimId: claim.id, leaseUntil: Math.min(now + HELD_LEASE_MS, state.deadlineAt) });
  }
}

export function cancelWork(state: WorkflowView, now: number, preserveClaims = false): void {
  const unfinished = state.workQueue?.items.filter(item => item.status === 'pending' || !preserveClaims && item.status === 'claimed') ?? [];
  if (!preserveClaims) releaseWorkClaims(state, now, 'Workflow cancelled');
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
    if (item.dependsOn?.some(key => workItemByKey(state, key)?.status !== 'completed')) continue;
    if (item.status !== 'pending' || item.hold || item.generation >= item.maxAttempts || item.resources.some(key => occupied.has(key))) continue;
    available.push(item);
    for (const key of item.resources) occupied.add(key);
  }
  return available;
}

/**
 * What a queue holds for one member, in the order claim_work hands it out: the items that are for this member come
 * first, whatever their priority, and the ones kept for another member are left out. The rest follow as
 * `availableWork` orders them.
 */
function workFor(state: WorkflowView, name: string | undefined, member: string | undefined): ItemView[] {
  const open = availableWork(state, name).filter(item => { const kept = keptFor(state, item); return !kept || kept === member; });
  return member === undefined ? open : [...open.filter(item => item.assignee === member), ...open.filter(item => item.assignee !== member)];
}

/**
 * How much work entered and left a queue, or all queues, in each of the last hours, oldest first: the last figure of
 * each list is the hour that ends now. A count of what is pending says how a queue stands; whether its work is being
 * planned and done at the rate it was an hour ago is in these.
 */
export function workFlow(state: WorkflowView, name: string | undefined, now: number): { enqueued: number[]; completed: number[]; failed?: number[] } | undefined {
  const perHour = 3_600_000 / WORK_FLOW_SLOT_MS;
  const hours = WORK_FLOW_SLOTS / perHour;
  const current = Math.floor(now / WORK_FLOW_SLOT_MS);
  const totals = { enqueued: new Array<number>(hours).fill(0), completed: new Array<number>(hours).fill(0), failed: new Array<number>(hours).fill(0) };
  let any = false;
  for (const [queue, slots] of Object.entries(state.workQueue?.flow ?? {})) {
    if (name !== undefined && queue !== name) continue;
    for (const slot of slots) {
      const age = current - slot.slot;
      if (age < 0 || age >= WORK_FLOW_SLOTS) continue;
      const hour = hours - 1 - Math.floor(age / perHour);
      totals.enqueued[hour]! += slot.enqueued ?? 0; totals.completed[hour]! += slot.completed ?? 0; totals.failed[hour]! += slot.failed ?? 0;
      any = true;
    }
  }
  if (!any) return undefined;
  return { enqueued: totals.enqueued, completed: totals.completed, ...(totals.failed.some(Boolean) ? { failed: totals.failed } : {}) };
}

export function workStatus(state: WorkflowView, args: Record<string, unknown> = {}, now?: number): unknown {
  options(args, ['itemId', 'key', 'offset', 'limit', 'queue']);
  const name = args.queue === undefined ? undefined : queueName(args.queue);
  if (args.itemId !== undefined || args.key !== undefined) {
    const item = itemOf(state, args);
    if (name !== undefined && (item.queue ?? 'default') !== name) throw new Error('Work item belongs to another queue');
    return { ...item, digest: undefined, claim: state.workQueue?.claims.find(claim => claim.id === item.claimId), ...writeOverlaps(state, item) };
  }
  const items = (state.workQueue?.items ?? []).filter(item => name === undefined || (item.queue ?? 'default') === name);
  const offset = boundedInteger(args.offset, 0, 0, WORK_MAX_ITEMS);
  const limit = boundedInteger(args.limit, 16, 1, 64);
  const counts = { pending: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of items) counts[item.status]++;
  const onHold = items.filter(item => item.status === 'pending' && item.hold).length;
  const flow = now === undefined ? undefined : workFlow(state, name, now);
  // Pending items a member could claim now; the rest wait on dependencies, resources held by claimed items or attempts.
  const claimable = availableWork(state, name).length;
  const members = new Map((state.agents ?? []).map(agent => [agent.agentId, agent.key]));
  // Archived items are counted; the page below lists the ones still in the state.
  let archived = 0;
  for (const [queue, totals] of Object.entries(state.workQueue?.archived ?? {})) {
    if (name !== undefined && queue !== name) continue;
    for (const [status, count] of Object.entries(totals)) { counts[status as keyof typeof counts] += count; archived += count; }
  }
  const controls = (name === undefined ? queueNames(state) : [name]).map(name => queueControl(state, name));
  return { total: items.length + archived, ...(archived ? { archived } : {}), ...counts, claimable, blocked: items.filter(item => item.status === 'pending').length - claimable, ...(onHold ? { onHold } : {}),
    ...(flow ? { flow } : {}), closed: controls.every(control => control?.closedAt !== undefined),
    closedAt: name === undefined ? state.workQueue?.closedAt : queueControl(state, name)?.closedAt,
    offset, nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit).map(item => {
    const claim = state.workQueue?.claims.find(claim => claim.id === item.claimId);
    // Who holds the item, so that a reader need not match the claim's agent ID against the member list.
    const member = item.status === 'claimed' && claim ? members.get(claim.agentId) : undefined;
    return {
    itemId: item.id, key: item.key, queue: item.queue ?? 'default', priority: item.priority ?? 0, dependsOn: item.dependsOn ?? [], title: item.title.slice(0, 120), ...(item.by ? { by: item.by } : {}),
    ...(item.origin ? { origin: item.origin } : {}), ...(item.assignee ? { assignee: item.assignee } : {}), ...(item.doneBy ? { doneBy: item.doneBy } : {}), status: item.status,
    generation: item.generation, maxAttempts: item.maxAttempts, progressVersion: item.progress.version, ...(item.hold ? { hold: true } : {}),
    claim, ...(member ? { member } : {}),
    error: item.error?.slice(0, 180),
  }; }) };
}

const WORK_STATUSES = ['pending', 'claimed', 'completed', 'failed', 'cancelled'];

/**
 * Finds work items by words in their key, title, input, result or error, including finished items that have left the
 * state. Items whose key or title match come first, then the most recently changed. A hit carries the text around
 * the match; work_status({itemId}) returns the whole item.
 */
export function searchWork(state: WorkflowView, args: Record<string, unknown> = {}): unknown {
  options(args, ['query', 'queue', 'status', 'limit']);
  const terms = searchTerms(args.query);
  const name = args.queue === undefined ? undefined : queueName(args.queue);
  if (args.status !== undefined && !WORK_STATUSES.includes(args.status as string)) throw new Error('status must be one of ' + WORK_STATUSES.join(', '));
  const limit = boundedInteger(args.limit, 10, 1, 30);
  const archived = state.archivedRecords?.workItem ? recordsOf(state).search('workItem', storedTerms(terms), SEARCH_ARCHIVE_ROWS) as WorkflowWorkItem[] : [];
  const hits = [];
  for (const item of [...state.workQueue?.items ?? [], ...archived]) {
    if (name !== undefined && (item.queue ?? 'default') !== name || args.status !== undefined && item.status !== args.status) continue;
    const hit = matchFields(terms, [['key', item.key], ['title', item.title], ['input', searchText(item.input)], ['result', searchText(item.result)], ['error', item.error ?? '']], 2);
    if (hit) hits.push({ item, hit });
  }
  hits.sort((a, b) => b.hit.score - a.hit.score || b.item.updatedAt - a.item.updatedAt);
  return { matches: hits.length, hasMore: hits.length > limit || archived.length === SEARCH_ARCHIVE_ROWS,
    items: hits.slice(0, limit).map(({ item, hit }) => ({ itemId: item.id, key: item.key, queue: item.queue ?? 'default', status: item.status, title: item.title.slice(0, 120),
      ...(item.by ? { by: item.by } : {}), ...(item.doneBy ? { doneBy: item.doneBy } : {}), updatedAt: item.updatedAt, in: hit.field, snippet: hit.snippet })) };
}

function ownedClaim(state: WorkflowView, task: TaskView, attemptId: string, args: Record<string, unknown>, now: number): ClaimView {
  const id = scriptText(args.claimId, 'claimId', 100);
  const claim = state.workQueue?.claims.find(claim => claim.id === id);
  if (!claim || claim.status !== 'active' || claim.frozen || claim.heldUntil !== undefined || claim.leaseUntil <= now || claim.agentId !== task.agentId
    || claim.taskId !== task.taskId || claim.attemptId !== attemptId || claim.generation !== args.generation) {
    throw new Error('Claim is stale, expired or belongs to another execution attempt');
  }
  const item = itemById(state, claim.itemId);
  if (item.claimId !== claim.id || item.generation !== claim.generation || item.status !== 'claimed') throw new Error('Claim no longer owns this work item');
  return claim;
}

/**
 * The record the previous attempt of this turn left for the very same request. An attempt that follows a host
 * restart continues that turn, in the same conversation and often the same process, and repeats a call whose answer
 * was lost with the old host; the claim ID and generation in the request make it the same operation.
 */
function repeatedOperation(state: WorkflowView, task: TaskView, attemptId: string, operationId: string, digest: string) {
  const index = task.attempts.findIndex(attempt => attempt.attemptId === attemptId);
  const earlier = index > 0 ? workOperationByKey(state, `${task.taskId}:${task.attempts[index - 1]!.attemptId}:${operationId}`) : undefined;
  return earlier?.digest === digest ? earlier : undefined;
}

/** The recorded response of a work operation of this attempt, so a repeated call can answer without acting again. */
export function workOperation(state: WorkflowView, task: TaskView, attemptId: string, operationId: unknown): { response: unknown } | undefined {
  const key = `${task.taskId}:${attemptId}:${scriptText(operationId, 'operationId', 160)}`;
  const prior = workOperationByKey(state, key);
  return prior && { response: prior.response };
}

/** Keeps the caller's claim leased for `leaseMs` more while the engine works on its behalf; throws once the claim is lost. */
export function holdClaim(state: WorkflowView, task: TaskView, attemptId: string, args: Record<string, unknown>, now: number, leaseMs: number): void {
  const claim = ownedClaim(state, task, attemptId, args, now);
  emit(state, { type: 'claim_renewed', claimId: claim.id, leaseUntil: Math.min(Math.max(claim.leaseUntil, now + leaseMs), state.deadlineAt) });
}

export function workContext(state: WorkflowView, task: TaskView): unknown {
  const claim = state.workQueue?.claims.find(claim => claim.status === 'active' && claim.taskId === task.taskId);
  const subscribed = memberQueue(state, state.agents?.find(agent => agent.agentId === task.agentId)?.key);
  return state.workQueue ? { total: state.workQueue.items.length + (state.archivedRecords?.workItem ?? 0), queue: subscribed ?? 'default',
    claim: claim ? { ...claim, item: workStatus(state, { itemId: claim.itemId }) } : null } : undefined;
}

/** Called synchronously after kernel authorization and lease expiry handling. */
export function mutateWork(state: WorkflowView, task: TaskView, attemptId: string,
  method: string, args: Record<string, unknown>, now: number): unknown {
  if (!task.agentId) throw new Error('Work claims require a persistent member');
  const allowed: Record<string, string[]> = {
    claim_work: ['leaseMs', 'queue'], checkpoint_work: ['expectedProgressVersion', 'state'],
    complete_work: ['result'], fail_work: ['error', 'retry'], release_claim: ['reason'],
  };
  if (!allowed[method]) throw new Error('Unknown work queue mutation');
  options(args, ['operationId', ...(method === 'claim_work' ? [] : ['claimId', 'generation']), ...allowed[method]!]);
  const operationId = scriptText(args.operationId, 'operationId', 160);
  const key = `${task.taskId}:${attemptId}:${operationId}`;
  const digest = workflowDigest({ method, args });
  const operations = state.workQueue?.operations ?? [];
  const prior = workOperationByKey(state, key) ?? (method === 'claim_work' ? undefined : repeatedOperation(state, task, attemptId, operationId, digest));
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
  if (operations.length >= WORK_MAX_OPERATIONS) throw new Error('Work operation limit reached');
  let response: unknown;
  if (method === 'claim_work') {
    const leaseMs = boundedInteger(args.leaseMs, 120_000, 1000, 300_000);
    const member = state.agents?.find(agent => agent.agentId === task.agentId)?.key;
    const subscribed = memberQueue(state, member);
    const name = queueName(args.queue ?? subscribed);
    if (subscribed && name !== subscribed) throw new Error('A member that consumes a queue cannot claim from another queue');
    const claims = state.workQueue?.claims ?? [];
    const held = claims.find(claim => claim.status === 'active' && claim.agentId === task.agentId);
    if (held && (held.taskId !== task.taskId || held.attemptId !== attemptId)) throw new Error('Member has a claim in another attempt');
    if (held && (itemById(state, held.itemId).queue ?? 'default') !== name) throw new Error('Member already has a claim in another queue');
    let claim: Pick<WorkClaim, 'id' | 'generation'> | undefined = held;
    if (!claim) {
      const item = workFor(state, name, member)[0];
      if (item) {
        if (claims.length >= WORK_MAX_CLAIMS) throw new Error('Work claim history limit reached');
        const granted: WorkClaim = { id: randomUUID(), itemId: item.id, agentId: task.agentId, taskId: task.taskId, attemptId,
          generation: item.generation + 1, leaseUntil: Math.min(now + leaseMs, state.deadlineAt), status: 'active', createdAt: now };
        emit(state, { type: 'work_claimed', claim: granted });
        claim = granted;
      }
    }
    response = claim ? { claimId: claim.id, generation: claim.generation } : null;
    if (!claim && subscribed) {
      // Another queue may have won the resource after dispatch. An empty claim is not a stalled turn.
      const swarm = state.swarms!.find(item => item.members.some(consumer => consumer.name === member))!;
      if (swarm.members.find(consumer => consumer.name === member)!.lastWake !== undefined) emit(state, { type: 'swarm_member_wake_cleared', swarmId: swarm.id, member: member! });
    }
  } else {
    const claim = ownedClaim(state, task, attemptId, args, now);
    const item = itemById(state, claim.itemId);
    switch (method) {
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
  capacity(state, args, response, key);
  return present(response);
}
