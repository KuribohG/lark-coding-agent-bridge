import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { tellMember } from './durable-agents';
import { byId } from './evolve';
import { archivedRecord, workItemByKey, workOperationByKey } from './kernel-state';
import { emit, recordsOf } from './kernel-store';
import { WORK_FLOW_SLOT_MS, WORK_FLOW_SLOTS, WORK_MAX_BYTES, WORK_MAX_CLAIMS, WORK_MAX_ITEMS, WORK_MAX_OPERATIONS } from './limits';
import { boundedInteger, scriptText } from './script-contract';
import { matchFields, SEARCH_ARCHIVE_ROWS, searchTerms, searchText, storedTerms } from './search';
import { consumes, MEMBER_NAME, memberQueue, queueControl, queueName, queueNames } from './work-routing';
import type { Immutable, TaskView, WorkClaim, WorkflowView, WorkflowWorkItem, WorkLandingReturn } from './types';

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

function resourceKeys(supplied: unknown): string[] {
  if (!Array.isArray(supplied) || supplied.length > 16) throw new Error('Work resources must be an array of at most 16 keys');
  const resources = [...new Set(supplied.map(value => scriptText(value, 'resource key', 200)))].sort();
  if (resources.some(resource => resource.trim() !== resource)) throw new Error('Resource keys must not contain surrounding whitespace');
  return resources;
}

function writePaths(written: unknown): string[] {
  if (!Array.isArray(written) || written.length > 16) throw new Error('Work writes must be an array of at most 16 paths');
  return [...new Set(written.map(writePath))].sort();
}

/** Whether `path` is `tree` or lies under it. Relative and absolute paths never meet. */
const under = (path: string, tree: string) => tree === '.' ? !path.startsWith('/') : tree === '/' ? path.startsWith('/') : path === tree || path.startsWith(tree + '/');

/** The keys an item waits for, directly or through the items it depends on. */
function prerequisites(state: WorkflowView, item: Pick<ItemView, 'dependsOn'>): Set<string> {
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

/** The unfinished items that wait on the item `key`. */
const dependents = (state: WorkflowView, key: string) => (state.workQueue?.items ?? []).filter(other => (other.status === 'pending' || other.status === 'claimed' || other.status === 'failed') && other.dependsOn?.includes(key));

/**
 * Looks items up by key, for a pass over many items: the ones in the state through one index instead of a search
 * each, the archived ones as they are asked for.
 */
export function itemsByKey(state: WorkflowView): (key: string) => ItemView | undefined {
  const index = new Map((state.workQueue?.items ?? []).map(item => [item.key, item]));
  return key => index.get(key) ?? archivedRecord<WorkflowWorkItem>(state, 'workItem', { key });
}

/** The dependencies an item still waits on, each with how it stands. */
export function waitsOn(state: WorkflowView, item: ItemView, find: (key: string) => ItemView | undefined = key => workItemByKey(state, key)): Array<{ key: string; status: string }> {
  return (item.dependsOn ?? []).flatMap(key => { const status = find(key)?.status ?? 'missing'; return status === 'completed' ? [] : [{ key, status }]; });
}

/**
 * The dependency that, as things stand, will never be completed: one that was cancelled, or that failed and has no
 * attempt left. What waits on it is never handed out until someone who plans it replaces the dependency, retries it
 * or changes what the item waits on.
 */
export const deadDependency = (waits: ReadonlyArray<{ key: string; status: string }>) => waits.find(entry => entry.status !== 'pending' && entry.status !== 'claimed');

/**
 * How the pending items of a queue (of every queue, without a name) stand: `blocked` are the items of work nobody can
 * claim now, of which `onHold` were set aside (`heldReady` of them with nothing else in their way) and `stuck` wait on
 * a dependency that will never be completed; `gates` are the conditions nobody has declared met.
 */
export function queueStanding(state: WorkflowView, name?: string): { claimable: number; blocked: number; onHold: number; heldReady: number; stuck: number; gates: number } {
  const standing = { claimable: availableWork(state, name).length, blocked: 0, onHold: 0, heldReady: 0, stuck: 0, gates: 0 };
  const find = itemsByKey(state);
  for (const item of state.workQueue?.items ?? []) {
    if (item.status !== 'pending' || name !== undefined && (item.queue ?? 'default') !== name) continue;
    const waits = item.dependsOn?.length ? waitsOn(state, item, find) : [];
    if (deadDependency(waits)) standing.stuck++;
    if (item.gate) { standing.gates++; continue; }
    standing.blocked++;
    if (item.hold) { standing.onHold++; if (!waits.length) standing.heldReady++; }
  }
  standing.blocked -= standing.claimable;
  return standing;
}

/** What a caller that replaced an item a member holds is told of that item. */
const HELD_NOTE = 'its member reads of this at its next turn (tell_worker reaches it now); the item is withdrawn when the claim ends, unless the member completes it first';
const KEYS_SHOWN = 16;
const keysShown = (keys: readonly string[], name: string, more: string) => keys.length ? { [name]: keys.slice(0, KEYS_SHOWN), ...(keys.length > KEYS_SHOWN ? { [more]: keys.length - KEYS_SHOWN } : {}) } : {};

/**
 * The keys to wait on in place of the ones named: an item that was replaced stands for its replacement, so that work
 * added later under the old key's name waits on what is to be done, not on an item that never will be.
 */
function current(state: WorkflowView, keys: readonly string[]): string[] {
  return [...new Set(keys.map(key => {
    for (let hops = 0; hops < 16; hops++) {
      const next = workItemByKey(state, key)?.supersededBy;
      if (next === undefined || !workItemByKey(state, next)) break;
      key = next;
    }
    return key;
  }))].sort();
}

function dependencyKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('dependsOn must contain at most 32 existing work keys');
  return [...new Set(value.map(entry => scriptText(entry, 'dependency key', 160)))].sort();
}

/**
 * Checks that the item `key` may be replaced by the item `next`, which waits on the keys in `before`. Whoever plans
 * the old item may replace it, and the member that added it while nobody has claimed it.
 */
function replaceable(state: WorkflowView, key: string, next: string, before: ReadonlySet<string>, authority: WorkAuthority): ItemView {
  const old = workItemByKey(state, key);
  if (!old) throw new Error(`Only an existing work item can be replaced; unknown key "${key.slice(0, 80)}"`);
  if (old.key === next) throw new Error('A work item cannot replace itself');
  if (old.supersededBy !== undefined && old.supersededBy !== next) throw new Error(`Work item "${old.key}" was already replaced by "${old.supersededBy}"`);
  const may = authority(old);
  if (may !== 'plans' && !(may === 'added' && (old.status === 'pending' || old.status === 'failed'))) {
    throw new Error(`Only whoever plans its queue, or the member that added it while nobody has claimed it, can replace work item "${old.key}"`);
  }
  if (old.status !== 'completed' && before.has(old.key)) throw new Error(`"${next}" waits on "${old.key}", the item it replaces, and would never be handed out`);
  const loop = dependents(state, old.key).find(other => other.key !== next && before.has(other.key));
  if (loop) throw new Error(`Replacing "${old.key}" would make "${loop.key}" wait on itself: "${next}" waits on it`);
  return old;
}

/**
 * Replaces `old` by the item `next`: every unfinished item that waited on the old one waits on the new one instead,
 * and the old one, unless it is completed, is withdrawn. One that a member holds is withdrawn when that member's
 * claim ends without completing it; the member is told in a message, which it reads at its next turn, so whoever
 * replaced the item speaks to it with tell_worker when it must stop now. Returns the keys of the items that now wait
 * on the replacement.
 *
 * Cancelling an item leaves everything that waited on it unclaimable, and an item's input cannot change, so a plan
 * that is revised was once re-issued under new keys with the old ones kept on hold as a record. This is the revision
 * as one step: the old key stays what it was, a finished item that names its replacement.
 */
function replace(state: WorkflowView, old: ItemView, next: string, now: number, by: string): string[] {
  const moved = dependents(state, old.key).filter(other => other.key !== next);
  for (const other of moved) emit(state, { type: 'work_updated', itemId: other.id, dependsOn: [...new Set(other.dependsOn!.map(key => key === old.key ? next : key))].sort(), at: now });
  // An item that has left the state is finished and nothing waits on it: there is nothing to record on it.
  if (old.supersededBy === next || !byId(state.workQueue?.items ?? [], found => found.id, old.id)) return moved.map(other => other.key);
  emit(state, { type: 'work_updated', itemId: old.id, supersededBy: next, at: now });
  if (old.status === 'pending' || old.status === 'failed') emit(state, { type: 'work_cancelled', itemIds: [old.id], at: now, reason: `Superseded by "${next}" (${by})` });
  const member = holder(state, old);
  // A mailbox that cannot take the message leaves the item to say it: its member reads supersededBy on it.
  if (member) {
    tellMember(state, member, `Work item "${old.key}", which you held when this was sent, was replaced by "${next}" (by ${by === 'main' ? 'the main agent' : by}): what waited on it now waits on the replacement. `
      + 'If you still hold it, stop and hand it back with release_claim; it is then withdrawn instead of returning to the queue. If you are about to finish, complete it: the result stands, though nothing waits on it any more.', now);
  }
  return moved.map(other => other.key);
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

/**
 * Adds an item. `gate: true` adds a condition instead of work: nobody claims it, and what depends on it waits until
 * settle_work declares it met. `supersedes` names the items the new one replaces (see `replace`). `authority` says
 * what the caller may do to those; `by` is the member that adds the item.
 */
export function enqueueWork(state: WorkflowView, args: Record<string, unknown>, now: number, by?: string, authority: WorkAuthority = () => 'plans'): unknown {
  options(args, ['key', 'title', 'input', 'resources', 'writes', 'maxAttempts', 'queue', 'priority', 'dependsOn', 'origin', 'assignee', 'gate', 'supersedes']);
  const key = scriptText(args.key, 'work key', 160);
  if (key.trim() !== key) throw new Error('Work key must not contain surrounding whitespace');
  const title = scriptText(args.title, 'work title', 500);
  const input = json(args.input, 'Work input');
  const maxAttempts = boundedInteger(args.maxAttempts, 3, 1, 32);
  const resources = resourceKeys(args.resources ?? []);
  const writes = writePaths(args.writes ?? []);
  const origin = args.origin === undefined ? undefined : scriptText(args.origin, 'origin key', 160);
  const source = origin === undefined ? undefined : workItemByKey(state, origin);
  const named = args.assignee === undefined ? undefined : assigneeName(args.assignee);
  // Work that follows from an item belongs, unless the caller says otherwise, where that item was done.
  const name = queueName(args.queue ?? source?.queue);
  const priority = boundedInteger(args.priority, 0, -100, 100);
  const dependsOn = dependencyKeys(args.dependsOn ?? []);
  if (dependsOn.includes(key)) throw new Error('A work item cannot wait on itself');
  if (args.gate !== undefined && typeof args.gate !== 'boolean') throw new Error('gate must be boolean');
  const gate = args.gate === true;
  if (gate && (named || resources.length || writes.length)) throw new Error('A gate is a condition that nobody claims: it takes no assignee, resources or writes');
  const replaced = args.supersedes === undefined ? [] : Array.isArray(args.supersedes) ? args.supersedes : [args.supersedes];
  if (replaced.length > 16) throw new Error('supersedes names at most 16 work keys');
  const supersedes = [...new Set(replaced.map(value => scriptText(value, 'superseded key', 160)))].sort();
  // Absent when empty, like the others, so that the digest of an item that names none is what it was before items could.
  // The digest holds what the caller named, not the member `origin` resolves to, which a replay may find changed.
  const routing = { ...(name !== 'default' ? { queue: name } : {}), ...(priority ? { priority } : {}), ...(dependsOn.length ? { dependsOn } : {}), ...(writes.length ? { writes } : {}),
    ...(origin !== undefined ? { origin } : {}), ...(gate ? { gate } : {}), ...(supersedes.length ? { supersedes } : {}) };
  const digest = workflowDigest({ key, title, input, maxAttempts, resources, ...routing, ...(named ? { assignee: named } : {}) });
  const items = state.workQueue?.items ?? [];
  const prior = workItemByKey(state, key);
  if (prior) {
    // A script repeats its calls on replay, so the item is held against the call that added it, not against what it
    // says now: an item that was amended since still answers its first call.
    if (prior.digest !== digest) throw new Error(`Work key conflict: "${key.slice(0, 80)}" was added with other content, and a call that adds an item is immutable across replay. `
      + 'To change an item nobody has claimed, amend it with update_work({key, title?, input?, writes?, resources?}); to replace one, add the new item under another key with supersedes');
    return { itemId: prior.id, key };
  }
  if (origin !== undefined && !source) throw new Error('origin must be the key of an existing work item');
  const assignee = gate ? undefined : named ?? (source && author(state, source));
  if (dependsOn.some(dependency => !workItemByKey(state, dependency))) throw new Error('Dependencies must reference existing work keys; enqueue prerequisites first');
  const waitsFor = current(state, dependsOn);
  const before = supersedes.length ? prerequisites(state, { dependsOn: waitsFor }) : new Set<string>();
  const olds = supersedes.map(old => replaceable(state, old, key, before, authority));
  if (queueControl(state, name)?.closedAt !== undefined) throw new Error('Work queue is closed; new items cannot be enqueued');
  if (items.length >= WORK_MAX_ITEMS) throw new Error('Work item limit reached');
  openQueue(state, name);
  const item: WorkflowWorkItem = { id: randomUUID(), key, title, ...(by ? { by } : {}), input, digest, maxAttempts, resources, ...routing, ...(waitsFor.length ? { dependsOn: waitsFor } : {}), ...(assignee ? { assignee } : {}),
    generation: 0, status: 'pending', progress: { version: 0, state: null }, createdAt: now, updatedAt: now };
  emit(state, { type: 'work_enqueued', item });
  capacity(state, item);
  for (const old of olds) replace(state, old, key, now, by ?? 'main');
  return { itemId: item.id, key };
}

/**
 * What became of the items a new item replaced, and what now waits on it, for the caller that added it. The script's
 * enqueueWork answers with the item alone (see `enqueued` in the tools).
 */
export function supersededView(state: WorkflowView, item: ItemView): Record<string, unknown> {
  if (!item.supersedes?.length) return {};
  return { superseded: item.supersedes.map(key => {
    const old = workItemByKey(state, key);
    const member = old && holder(state, old);
    return { key, status: old?.status, ...(member ? { claimedBy: member, note: HELD_NOTE } : {}) };
  }), ...keysShown(dependents(state, item.key).map(other => other.key), 'waitingOnIt', 'moreWaitingOnIt') };
}

/**
 * A persistent member adds work it found. A key that already exists answers with that item instead of failing, so
 * members that report the same finding do not duplicate it. Members add to queues that exist: by default the queue of
 * the item the work follows from (`origin`), else their own.
 */
export function enqueueFromMember(state: WorkflowView, task: TaskView, args: Record<string, unknown>, now: number, authorityOf?: (member: string) => WorkAuthority): unknown {
  if (!task.agentId) throw new Error('enqueue_work requires a persistent member');
  const member = state.agents?.find(agent => agent.agentId === task.agentId)?.key;
  const { operationId: _operationId, ...input } = args;
  const key = scriptText(input.key, 'work key', 160);
  const prior = workItemByKey(state, key);
  if (prior) return { itemId: prior.id, key, existing: true, status: prior.status, title: prior.title.slice(0, 120) };
  const source = input.origin === undefined ? undefined : workItemByKey(state, scriptText(input.origin, 'origin key', 160));
  const name = queueName(input.queue ?? (source ? source.queue ?? 'default' : memberQueue(state, member)));
  if (!queueNames(state).includes(name)) throw new Error(`Unknown work queue; members add to existing queues: ${queueNames(state).join(', ')}`);
  return enqueueWork(state, { ...input, queue: name }, now, member, member && authorityOf ? authorityOf(member) : item => item.by !== undefined && item.by === member ? 'added' : undefined);
}

export function retryWork(state: WorkflowView, args: Record<string, unknown>, now: number, authority: WorkAuthority = () => 'plans'): unknown {
  options(args, ['itemId', 'key', 'additionalAttempts']);
  const item = itemOf(state, args);
  if (authority(item) !== 'plans') throw new Error('Only the main agent, the swarm lead or the lead of its queue can retry a work item');
  if (item.status !== 'failed') throw new Error('Only failed work items can be retried');
  const attempts = boundedInteger(args.additionalAttempts, 1, 1, 8);
  const failures = item.failures ?? 0;
  if (failures + attempts > 32) throw new Error('Work item attempt limit reached');
  emit(state, { type: 'work_retried', itemId: item.id, maxAttempts: Math.max(item.maxAttempts, failures + attempts), at: now });
  return { itemId: item.id, status: item.status, maxAttempts: item.maxAttempts };
}

/** An item as the caller that changed it is shown it: where it stands and, while it is pending, what still keeps it from being handed out. */
function changedView(state: WorkflowView, found: ItemView): Record<string, unknown> {
  const waits = found.status === 'pending' ? waitsOn(state, found) : [];
  return { itemId: found.id, key: found.key, queue: found.queue ?? 'default', status: found.status, priority: found.priority ?? 0, ...(found.gate ? { gate: true } : {}), ...(found.revision ? { revision: found.revision } : {}),
    ...(found.hold ? { hold: true, ...(found.held?.reason ? { holdReason: found.held.reason } : {}) } : {}), ...(waits.length ? { waitsOn: waits.slice(0, 8) } : {}), ...assigned(state, found) };
}

/**
 * Changes an item that is not finished, for whoever plans its queue: `title`, `input`, `writes` and `resources`
 * rewrite what it asks for while nobody has claimed it, `priority` moves it in the order items are handed out, `hold`
 * sets it aside (true, with the `reason`) or returns it (false), `assignee` gives it to one member (a name) or back
 * to the whole queue (null), `dependsOn` replaces what it waits on, `supersededBy` replaces it by another item (see
 * `replace`) and `cancel` withdraws it. Work that has become pointless otherwise stays in the queue
 * until a member claims it and gives it up. A claimed item is not cancelled here: its member is at work on it and is
 * the one to stop.
 *
 * A hold says that someone decided to set the item aside, and only that someone can lift it. An item that waits for
 * something is not held: what it waits for is named in `dependsOn`, an item or a gate, and the item is handed out by
 * itself once that is done. The reason a hold must give is what tells the two apart later.
 */
const AMENDABLE = ['title', 'input', 'writes', 'resources'];

export function updateWork(state: WorkflowView, args: Record<string, unknown>, now: number, authority: WorkAuthority = () => 'plans', by = 'main'): unknown {
  options(args, ['itemId', 'key', 'priority', 'hold', 'assignee', 'dependsOn', 'supersededBy', 'cancel', 'reason', ...AMENDABLE]);
  const item = itemOf(state, args);
  const may = authority(item);
  if (args.cancel !== undefined && args.cancel !== true) throw new Error('cancel must be true');
  if (args.hold !== undefined && typeof args.hold !== 'boolean') throw new Error('hold must be boolean');
  const routes = args.priority !== undefined || args.hold !== undefined || args.assignee !== undefined || args.dependsOn !== undefined;
  const amends = AMENDABLE.some(field => Object.hasOwn(args, field));
  const changes = routes || amends;
  const replaces = args.supersededBy !== undefined;
  if (!changes && !args.cancel && !replaces) throw new Error('Give title, input, writes, resources, priority, hold, assignee, dependsOn, supersededBy or cancel');
  if (args.cancel && (changes || replaces) || replaces && changes) throw new Error('cancel withdraws the item and supersededBy replaces it; give either alone, not with a change to the item');
  if (args.reason !== undefined && !args.cancel && args.hold !== true) throw new Error('reason belongs to cancel and to hold: true');
  if (!may || may === 'added' && routes) throw new Error(may ? 'A member can amend (title, input, writes, resources), withdraw (cancel) or replace (supersededBy) an item it added; its priority, hold, assignee and dependsOn are for the lead that plans the queue'
    : 'Only the main agent, the swarm lead, the lead of its queue or, to amend, cancel or replace it, the member that added it can change a work item');
  if (replaces) {
    const next = workItemByKey(state, scriptText(args.supersededBy, 'supersededBy', 160));
    if (!next) throw new Error('supersededBy is the key of an existing work item: add the replacement first, or add it with enqueue_work and supersedes');
    if (next.status === 'cancelled') throw new Error(`Work item "${next.key}" is cancelled and can replace nothing`);
    const claimedBy = holder(state, item);
    const moved = replace(state, replaceable(state, item.key, next.key, prerequisites(state, next), authority), next.key, now, by);
    return { ...changedView(state, item), supersededBy: next.key, ...keysShown(moved, 'nowWaitOnIt', 'moreNowWaitOnIt'),
      ...(claimedBy && item.status === 'claimed' ? { claimedBy, note: HELD_NOTE } : {}) };
  }
  if (args.cancel) {
    const reason = args.reason === undefined ? undefined : scriptText(args.reason, 'reason', 500).trim() || undefined;
    if (item.status === 'cancelled') return changedView(state, item);
    if (item.status === 'completed') throw new Error('Work item is already completed');
    if (item.status === 'claimed') {
      const member = holder(state, item);
      throw new Error(`Work item is claimed${member ? ' by ' + member : ''}; have that member stop and hand it back (tell_worker, for a lead and the main agent; ask otherwise), and cancel the item once it has returned to the queue`);
    }
    emit(state, { type: 'work_cancelled', itemIds: [item.id], at: now, reason: `Cancelled by ${by}` + (reason ? ': ' + reason : '') });
    // What waited on the item can no longer be claimed; whoever cancelled it decides what becomes of that work.
    const blocks = dependents(state, item.key).filter(other => other.status !== 'claimed').map(other => other.key);
    return { ...changedView(state, item), ...keysShown(blocks, 'blocks', 'moreBlocked'), ...(blocks.length ? { note: 'blocks can no longer be claimed. If other work takes this item\'s place, '
      + 'update_work({key: this key, supersededBy: its key}) makes them wait on that instead; otherwise give each a new dependsOn or cancel it' } : {}) };
  }
  if (item.status === 'completed' || item.status === 'cancelled') throw new Error(`Work item is already ${item.status}`);
  if (item.gate && (args.hold !== undefined || args.assignee !== undefined)) throw new Error('A gate is not handed out, so it takes no hold and no assignee: settle_work declares it met, cancel withdraws it');
  const priority = args.priority === undefined ? undefined : boundedInteger(args.priority, 0, -100, 100);
  const hold = args.hold as boolean | undefined;
  const reason = hold !== true || args.reason === undefined ? undefined : scriptText(args.reason, 'reason', 500).trim() || undefined;
  if (hold === true && !reason) throw new Error('hold: true needs a reason: what the item is set aside for, and what would bring it back. '
    + 'Do not hold an item that only waits for something: name what it waits for in dependsOn, an item or a gate (enqueue_work with gate: true, declared met with settle_work), and it is handed out by itself');
  const assignee = args.assignee === undefined ? undefined : args.assignee === null ? null : assigneeName(args.assignee);
  let dependsOn: string[] | undefined;
  if (args.dependsOn !== undefined) {
    if (item.status === 'claimed') throw new Error('Work item is claimed; what it waits on can change once it is back in the queue');
    const named = dependencyKeys(args.dependsOn);
    if (named.some(key => !workItemByKey(state, key))) throw new Error('Dependencies must reference existing work keys; enqueue prerequisites first');
    dependsOn = current(state, named);
    for (const key of dependsOn) {
      const dependency = key === item.key ? undefined : workItemByKey(state, key);
      if (!dependency) throw new Error('A work item cannot wait on itself');
      if (prerequisites(state, dependency).has(item.key)) throw new Error(`"${key}" waits on this item, so this item cannot wait on it`);
    }
  }
  // What an item asks for can be rewritten while nobody works from it. A plan that changed was once re-issued under
  // new keys, since an item could not change; the old keys stayed behind, cancelled or set aside.
  const amend: { title?: string; input?: unknown; writes?: string[]; resources?: string[] } = {};
  if (amends) {
    if (item.status === 'claimed') {
      const member = holder(state, item);
      throw new Error(`Work item is claimed${member ? ' by ' + member : ''}, which works from what the item said: tell that member what changed (tell_worker), or replace the item (supersededBy)`);
    }
    if (args.title !== undefined) { const title = scriptText(args.title, 'work title', 500); if (title !== item.title) amend.title = title; }
    if (Object.hasOwn(args, 'input')) { const input = json(args.input, 'Work input'); if (JSON.stringify(input) !== JSON.stringify(item.input)) amend.input = input; }
    if (args.writes !== undefined) { const writes = writePaths(args.writes); if (writes.join('\n') !== (item.writes ?? []).join('\n')) amend.writes = writes; }
    if (args.resources !== undefined) { const resources = resourceKeys(args.resources); if (resources.join('\n') !== item.resources.join('\n')) amend.resources = resources; }
    if (item.gate && (amend.writes?.length || amend.resources?.length)) throw new Error('A gate is a condition that nobody claims: it takes no resources or writes');
  }
  const changed = { ...(Object.keys(amend).length ? { amend } : {}), ...(priority !== undefined && priority !== (item.priority ?? 0) ? { priority } : {}),
    ...(hold !== undefined && (hold !== Boolean(item.hold) || hold && reason !== item.held?.reason) ? { hold, ...(hold ? { held: { by, at: now, reason } } : {}) } : {}),
    ...(assignee !== undefined && assignee !== (item.assignee ?? null) ? { assignee } : {}),
    ...(dependsOn && dependsOn.join('\n') !== (item.dependsOn ?? []).join('\n') ? { dependsOn } : {}) };
  if (Object.keys(changed).length) emit(state, { type: 'work_updated', itemId: item.id, ...changed, at: now });
  if (changed.amend) capacity(state, changed.amend);
  return { ...changedView(state, item), ...(changed.amend ? writeOverlaps(state, item) : {}) };
}

/**
 * Declares an item done without a claim. It is how a gate is met, by whoever plans it or by the member that added
 * it, and how whoever plans a queue ends the wait for work that was done some other way. `result` says what was
 * established and how, for those who read the item later. The answer names the items this released, and the ones
 * that waited on it and are still not handed out.
 */
export function settleWork(state: WorkflowView, args: Record<string, unknown>, now: number, authority: WorkAuthority = () => 'plans', by = 'main'): unknown {
  options(args, ['itemId', 'key', 'result']);
  const item = itemOf(state, args);
  if (!Object.hasOwn(args, 'result')) throw new Error('settle_work requires result: what was established, and how');
  const may = authority(item);
  if (may !== 'plans' && !(may === 'added' && item.gate)) throw new Error(may ? 'A member settles a gate it added; an item of work is done by the member that claims it, or settled by whoever plans its queue'
    : 'Only the main agent, the swarm lead, the lead of its queue or, for a gate, the member that added it can settle a work item');
  if (item.status === 'completed' || item.status === 'cancelled') throw new Error(`Work item is already ${item.status}`);
  if (item.status === 'claimed') {
    const member = holder(state, item);
    throw new Error(`Work item is claimed${member ? ' by ' + member : ''}, which completes it`);
  }
  const waiting = dependents(state, item.key).filter(other => other.status === 'pending');
  emit(state, { type: 'work_updated', itemId: item.id, settled: { by, result: json(args.result, 'Work result') }, at: now });
  capacity(state, args.result);
  const open = new Set(availableWork(state).map(other => other.id));
  const rest = waiting.filter(other => !open.has(other.id));
  const held = rest.filter(other => other.hold && !waitsOn(state, other).length);
  return { ...changedView(state, item), ...keysShown(waiting.filter(other => open.has(other.id)).map(other => other.key), 'released', 'moreReleased'),
    ...keysShown(held.map(other => other.key), 'stillOnHold', 'moreStillOnHold'), ...(rest.length > held.length ? { stillWaiting: rest.length - held.length } : {}) };
}

/**
 * Ends a claim. `counted` says that the attempt failed through its member, which is what an item's attempts count:
 * the member gave the item up, or its turn broke down. A claim that was handed back, ran out or was stopped from
 * outside returns its item without using one up.
 */
function endClaim(state: WorkflowView, claim: ClaimView, now: number,
  status: Exclude<WorkClaim['status'], 'active' | 'completed'>, reason: string, retry: boolean, counted = false): void {
  emit(state, { type: 'claim_ended', claimId: claim.id, status, reason: reason.slice(0, 1000), retry, at: now, ...(counted ? { counted } : {}) });
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
    // The landing queue renews the lease of what it holds: a submission whose lease ran out was lost with its queue.
    // It has no turn to cancel, so it is not among the claims returned.
    if (claim.landing) turnBack(state, claim, now, { status: 'lost', reason: SUBMISSION_LOST });
    else if (now < state.deadlineAt && held(claim)) emit(state, { type: 'claim_renewed', claimId: claim.id, leaseUntil: Math.min(now + HELD_LEASE_MS, state.deadlineAt) });
    else { endClaim(state, claim, now, 'expired', 'Claim lease expired', true); expired.push(claim); }
  }
  return expired;
}

/**
 * Returns the claims of a turn, or of every turn, to the queue. `counted`: the turn broke down by itself (see
 * `endClaim`). A claim the landing queue holds (`landing`) does not end with the turn that submitted it.
 */
export function releaseWorkClaims(state: WorkflowView, now: number, reason: string, taskId?: string, attemptId?: string, counted = false): void {
  for (const claim of state.workQueue?.claims ?? []) {
    if (claim.landing && taskId) continue;
    if (claim.status === 'active' && (!claim.frozen || attemptId === claim.attemptId)
      && (!taskId || claim.taskId === taskId) && (!attemptId || claim.attemptId === attemptId)) {
      endClaim(state, claim, now, 'cancelled', reason, true, counted);
    }
  }
}

export function freezeWorkClaims(state: WorkflowView, reason: string, taskId?: string): void {
  for (const claim of state.workQueue?.claims ?? []) {
    if (claim.status === 'active' && !claim.frozen && !claim.landing && (!taskId || claim.taskId === taskId))
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
    if (claim.status === 'active' && !claim.frozen && !claim.landing) emit(state, { type: 'claim_held', claimId: claim.id, until });
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
    if (item.status !== 'pending' || item.gate || item.hold || (item.failures ?? 0) >= item.maxAttempts || item.resources.some(key => occupied.has(key))) continue;
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
    const waits = item.status === 'pending' || item.status === 'failed' ? waitsOn(state, item) : [];
    return { ...item, digest: undefined, claim: state.workQueue?.claims.find(claim => claim.id === item.claimId), ...(waits.length ? { waitsOn: waits } : {}),
      ...(item.status === 'completed' ? {} : keysShown(dependents(state, item.key).map(other => other.key), 'neededBy', 'moreNeededBy')), ...writeOverlaps(state, item) };
  }
  const items = (state.workQueue?.items ?? []).filter(item => name === undefined || (item.queue ?? 'default') === name);
  const offset = boundedInteger(args.offset, 0, 0, WORK_MAX_ITEMS);
  const limit = boundedInteger(args.limit, 16, 1, 64);
  const counts = { pending: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of items) counts[item.status]++;
  // Of the claimed items, the ones no member is at: their commits are with the landing queue.
  const submitted = (state.workQueue?.claims ?? []).filter(claim => claim.status === 'active' && claim.landing && (name === undefined || (itemById(state, claim.itemId).queue ?? 'default') === name)).length;
  const flow = now === undefined ? undefined : workFlow(state, name, now);
  // Pending items a member could claim now; the rest wait on dependencies, resources held by claimed items or attempts,
  // or were set aside. Gates are conditions and are counted apart.
  const { claimable, blocked, onHold, heldReady, stuck, gates } = queueStanding(state, name);
  const members = new Map((state.agents ?? []).map(agent => [agent.agentId, agent.key]));
  // Archived items are counted; the page below lists the ones still in the state.
  let archived = 0;
  for (const [queue, totals] of Object.entries(state.workQueue?.archived ?? {})) {
    if (name !== undefined && queue !== name) continue;
    for (const [status, count] of Object.entries(totals)) { counts[status as keyof typeof counts] += count; archived += count; }
  }
  const controls = (name === undefined ? queueNames(state) : [name]).map(name => queueControl(state, name));
  return { total: items.length + archived, ...(archived ? { archived } : {}), ...counts, ...(submitted ? { submitted } : {}), claimable, blocked, ...(onHold ? { onHold } : {}), ...(heldReady ? { heldReady } : {}), ...(stuck ? { stuck } : {}), ...(gates ? { gates } : {}),
    ...(flow ? { flow } : {}), closed: controls.every(control => control?.closedAt !== undefined),
    closedAt: name === undefined ? state.workQueue?.closedAt : queueControl(state, name)?.closedAt,
    offset, nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit).map(item => {
    const claim = state.workQueue?.claims.find(claim => claim.id === item.claimId);
    // Who holds the item, so that a reader need not match the claim's agent ID against the member list.
    const member = item.status === 'claimed' && claim ? members.get(claim.agentId) : undefined;
    const waits = item.status === 'pending' ? waitsOn(state, item) : [];
    return {
    itemId: item.id, key: item.key, queue: item.queue ?? 'default', priority: item.priority ?? 0, dependsOn: item.dependsOn ?? [], title: item.title.slice(0, 120), ...(item.by ? { by: item.by } : {}),
    ...(item.origin ? { origin: item.origin } : {}), ...(item.assignee ? { assignee: item.assignee } : {}), ...(item.doneBy ? { doneBy: item.doneBy } : {}), status: item.status,
    generation: item.generation, ...(item.failures ? { failures: item.failures } : {}), maxAttempts: item.maxAttempts, progressVersion: item.progress.version,
    ...(item.revision ? { revision: item.revision } : {}), ...(item.gate ? { gate: true } : {}),
    ...(item.hold ? { hold: true, ...(item.held ? { held: { ...item.held, ...(item.held.reason ? { reason: item.held.reason.slice(0, 160) } : {}) } } : {}) } : {}),
    ...(waits.length ? { waitsOn: waits.slice(0, 8) } : {}), ...(item.supersededBy ? { supersededBy: item.supersededBy } : {}), ...(item.settledBy ? { settledBy: item.settledBy } : {}),
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
  if (claim?.status === 'active' && claim.landing && claim.agentId === task.agentId) throw new Error('This item is with the landing queue, which has your commits: '
    + 'it is completed when they land and comes back to you when they are turned back (withdraw_work takes them out of the queue when they should not land). Claim your next item');
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

/**
 * A lease the engine holds for a submission that is with the landing queue. The queue renews it while it has the
 * submission, so a lease that ran out says the queue lost it.
 */
const SUBMITTED_LEASE_MS = 600_000;
const SUBMISSION_LOST = 'The landing queue lost this submission before it had an answer (the bridge restarted, or the queue failed). The commits are untouched: claim_work puts them back into your worktree; submit them again.';

/** A landing report as an item keeps it: long text is cut to its end, where a command that failed says why. */
function clipped(report: unknown): unknown {
  for (let keep = 8000; ; keep = Math.floor(keep / 2)) {
    const cut = JSON.parse(JSON.stringify(report ?? null, (_key, value: unknown) => typeof value === 'string' && value.length > keep ? '…' + value.slice(-keep) : value)) as unknown;
    if (keep < 200 || JSON.stringify(cut).length <= 16_000) return cut;
  }
}

/**
 * Returns an item whose commits the landing queue did not land to the member that submitted them: the item is that
 * member's again (it is handed out to it before other work), keeps what the queue answered, and the member is told.
 * It does not use up an attempt: the member did not give the item up.
 */
function turnBack(state: WorkflowView, claim: ClaimView, now: number, back: { status: string; reason?: string; report?: unknown }): void {
  const { targetCommit, headCommit } = claim.landing!, commits = `${targetCommit}..${headCommit}`;
  const item = itemById(state, claim.itemId), member = state.agents?.find(agent => agent.agentId === claim.agentId)?.key;
  const reason = back.reason?.trim().slice(0, 2000);
  const returned: WorkLandingReturn = { at: now, status: back.status, ...(reason ? { reason } : {}), commits, ...(back.report === undefined ? {} : { report: clipped(back.report) }) };
  endClaim(state, claim, now, 'released', `The landing queue turned back the commits ${commits} (${back.status})${reason ? ': ' + reason.split('\n')[0]!.slice(0, 300) : ''}`, true);
  // After the claim has ended: the item moved, and did not come round with nothing done.
  emit(state, { type: 'work_updated', itemId: item.id, ...(member ? { assignee: member } : {}), landing: returned, at: now });
  capacity(state, returned);
  if (member && item.status === 'pending') tellMember(state, member, `The landing queue turned back the commits you submitted for work item "${item.key}" (${back.status})${reason ? ': ' + reason.split('\n')[0]!.slice(0, 300) : ''}. `
    + `The item is yours again: finish what you are doing, then claim_work hands it to you before other work, with what the queue answered in item.landing. claim_work puts your commits ${commits} back into your worktree.`, now);
}

/** What a submission is answered once the landing queue holds it, and the claim the engine holds for it from then on. */
interface Submitted { response: unknown; claim: Record<string, unknown> }

/** The claim of a submission the landing queue holds, named as the member named it. */
function submission(state: WorkflowView, args: Record<string, unknown>): ClaimView {
  const claim = state.workQueue?.claims.find(claim => claim.id === args.claimId);
  if (!claim || claim.status !== 'active' || !claim.landing || claim.generation !== args.generation) throw new Error('The work item is no longer with the landing queue');
  return claim;
}

/**
 * Hands the caller's claim to the landing queue. Its commits passed what is checked in its own worktree and wait for a
 * train; the member goes on to its next item, and the engine holds the claim until the queue has answered
 * (`completeSubmission`, `returnSubmission`). The answer is recorded for `operationId`, so a repeated call reads it.
 */
export function submitClaim(state: WorkflowView, task: TaskView, attemptId: string, args: Record<string, unknown>, now: number,
  landing: Omit<NonNullable<WorkClaim['landing']>, 'since'>, worktree: string): Submitted {
  const operationId = scriptText(args.operationId, 'operationId', 160);
  const claim = ownedClaim(state, task, attemptId, args, now), item = itemById(state, claim.itemId);
  if ((state.workQueue?.operations ?? []).length >= WORK_MAX_OPERATIONS) throw new Error('Work operation limit reached');
  emit(state, { type: 'claim_submitted', claimId: claim.id, landing: { since: now, ...landing } });
  // A renewal, not the hand-over, is what a replay reads the lease from.
  emit(state, { type: 'claim_renewed', claimId: claim.id, leaseUntil: Math.min(now + SUBMITTED_LEASE_MS, state.deadlineAt) });
  const response = { status: 'submitted', itemId: item.id, key: item.key, ...landing, worktree };
  emit(state, { type: 'work_operation_recorded', operation: { key: `${task.taskId}:${attemptId}:${operationId}`,
    digest: workflowDigest({ method: 'submit_work', claimId: claim.id, generation: claim.generation }), response } });
  capacity(state, response);
  return { response, claim: { claimId: claim.id, generation: claim.generation } };
}

/**
 * Commits a member submitted for no work item get an item of their own, which the landing queue holds from the start.
 * Every submission is then followed, completed and returned in the same way, and a script can wait for one with
 * waitWork. The item is added to the member's queue even when that is closed: it is not new work, and becomes work
 * only if the queue turns the commits back.
 */
export function trackSubmission(state: WorkflowView, task: TaskView, attemptId: string, operationId: unknown, now: number,
  landing: Omit<NonNullable<WorkClaim['landing']>, 'since'>, worktree: string): Submitted {
  const operation = scriptText(operationId, 'operationId', 160);
  const work = state.workQueue;
  if ((work?.operations ?? []).length >= WORK_MAX_OPERATIONS) throw new Error('Work operation limit reached');
  if ((work?.items ?? []).length >= WORK_MAX_ITEMS) throw new Error('Work item limit reached');
  if ((work?.claims ?? []).length >= WORK_MAX_CLAIMS) throw new Error('Work claim history limit reached');
  const member = state.agents?.find(agent => agent.agentId === task.agentId)?.key;
  const name = memberQueue(state, member) ?? 'default';
  openQueue(state, name);
  const commits = `${landing.targetCommit}..${landing.headCommit}`, stem = `submitted-${landing.headCommit.slice(0, 12)}`;
  let key = stem;
  for (let again = 2; workItemByKey(state, key); again++) key = `${stem}-${again}`;
  const title = `Commits ${commits} that ${member ?? 'a task'} submitted for no work item`;
  const input = { commits, count: landing.commits, note: 'Added by submit_work to follow these commits through the landing queue. It is completed when they land.' };
  const item: WorkflowWorkItem = { id: randomUUID(), key, title, ...(member ? { by: member } : {}), input, digest: workflowDigest({ key, title, input }), maxAttempts: 3, resources: [],
    ...(name !== 'default' ? { queue: name } : {}), ...(member ? { assignee: member } : {}), generation: 0, status: 'pending', progress: { version: 0, state: null }, createdAt: now, updatedAt: now };
  emit(state, { type: 'work_enqueued', item });
  const leaseUntil = Math.min(now + SUBMITTED_LEASE_MS, state.deadlineAt);
  // A task that is no persistent member has no agent: the claim names the task, and an item that comes back is anyone's.
  const claim: WorkClaim = { id: randomUUID(), itemId: item.id, agentId: task.agentId ?? `task:${task.taskId}`, taskId: task.taskId, attemptId, generation: 1, progress: 0, leaseUntil, status: 'active', createdAt: now };
  emit(state, { type: 'work_claimed', claim });
  emit(state, { type: 'claim_submitted', claimId: claim.id, landing: { since: now, ...landing } });
  emit(state, { type: 'claim_renewed', claimId: claim.id, leaseUntil });
  const response = { status: 'submitted', itemId: item.id, key, ...landing, worktree };
  emit(state, { type: 'work_operation_recorded', operation: { key: `${task.taskId}:${attemptId}:${operation}`, digest: workflowDigest({ method: 'submit_work', headCommit: landing.headCommit }), response } });
  capacity(state, item, response);
  return { response, claim: { claimId: claim.id, generation: claim.generation } };
}

/** The item a task is at work on, and its claim: the one it holds that is not with the landing queue. */
export function heldWork(state: WorkflowView, task: TaskView): { key: string; claimId: string; generation: number } | undefined {
  const claim = state.workQueue?.claims.find(claim => claim.status === 'active' && !claim.landing && (task.agentId ? claim.agentId === task.agentId : claim.taskId === task.taskId));
  return claim && { key: itemById(state, claim.itemId).key, claimId: claim.id, generation: claim.generation };
}

/** Keeps a submission with the landing queue for one more lease; throws once the item is no longer the queue's to land. */
export function holdSubmission(state: WorkflowView, args: Record<string, unknown>, now: number): void {
  emit(state, { type: 'claim_renewed', claimId: submission(state, args).id, leaseUntil: Math.min(now + SUBMITTED_LEASE_MS, state.deadlineAt) });
}

/** The commits of a submission landed: its item is completed, as the work of the member that submitted it. */
export function completeSubmission(state: WorkflowView, args: Record<string, unknown>, result: unknown, now: number): unknown {
  const claim = submission(state, args), item = itemById(state, claim.itemId);
  emit(state, { type: 'work_completed', claimId: claim.id, result: json(result, 'Work result'), at: now });
  capacity(state, result);
  return { itemId: item.id, status: item.status, generation: item.generation };
}

/**
 * The commits of an item the landing queue holds, for a request to take them out of the queue (withdraw_work) or to
 * put them at its head (expedite_work); `refused` is what a caller that may not ask it is told.
 * Whoever plans the item's queue may ask, and so may the member that submitted them, which `mine` tells by the claim.
 * An item the queue does not hold is answered as it stands: the queue has dealt with its commits already.
 */
export function submittedCommits(state: WorkflowView, args: Record<string, unknown>, authority: WorkAuthority = () => 'plans', mine: (claim: ClaimView) => boolean = () => false,
  refused = 'Commits are withdrawn from the landing queue by the member that submitted them, the main agent, the swarm lead or the lead of their queue'):
  { itemId: string; key: string; member?: string; targetCommit: string; headCommit: string } | { itemId: string; key: string; status: string; landing?: string } {
  options(args, ['itemId', 'key']);
  const item = itemOf(state, args);
  const claim = state.workQueue?.claims.find(claim => claim.status === 'active' && claim.landing && claim.itemId === item.id);
  if (!claim) return { itemId: item.id, key: item.key, status: item.status, ...(item.landing ? { landing: item.landing.status } : {}) };
  if (!mine(claim) && authority(item) !== 'plans') throw new Error(refused);
  const member = state.agents?.find(agent => agent.agentId === claim.agentId)?.key;
  return { itemId: item.id, key: item.key, ...(member ? { member } : {}), targetCommit: claim.landing!.targetCommit, headCommit: claim.landing!.headCommit };
}

/** The landing queue did not land a submission: see `turnBack`. */
export function returnSubmission(state: WorkflowView, args: Record<string, unknown>, now: number, back: { status: string; reason?: string; report?: unknown }): void {
  turnBack(state, submission(state, args), now, back);
}

/**
 * Whether the landing queue holds work of these queues (of any, when none is named). Such work is in flight though no
 * member is at it: its answer completes an item or brings one back.
 */
export function submittedWork(state: WorkflowView, names?: readonly string[]): boolean {
  return state.workQueue?.claims.some(claim => claim.status === 'active' && claim.landing
    && (!names || names.includes(itemById(state, claim.itemId).queue ?? 'default'))) ?? false;
}

/**
 * The landing queue is held in memory, so a restart loses what waited in it. Every submission goes back to its member,
 * whose commits are where it left them.
 */
export function returnSubmissions(state: WorkflowView, now: number): number {
  const lost = state.workQueue?.claims.filter(claim => claim.status === 'active' && claim.landing) ?? [];
  for (const claim of lost) turnBack(state, claim, now, { status: 'lost', reason: SUBMISSION_LOST });
  return lost.length;
}

export function workContext(state: WorkflowView, task: TaskView): unknown {
  const claim = state.workQueue?.claims.find(claim => claim.status === 'active' && !claim.landing && claim.taskId === task.taskId);
  const subscribed = memberQueue(state, state.agents?.find(agent => agent.agentId === task.agentId)?.key);
  // What the member handed to the landing queue and is not at work on: these complete, or come back, by themselves.
  const submitted = state.workQueue?.claims.filter(claim => claim.status === 'active' && claim.landing && claim.agentId === task.agentId).map(claim => itemById(state, claim.itemId).key) ?? [];
  return state.workQueue ? { total: state.workQueue.items.length + (state.archivedRecords?.workItem ?? 0), queue: subscribed ?? 'default',
    claim: claim ? { ...claim, item: workStatus(state, { itemId: claim.itemId }) } : null,
    ...(submitted.length ? { submitted: submitted.slice(0, 16), ...(submitted.length > 16 ? { moreSubmitted: submitted.length - 16 } : {}) } : {}) } : undefined;
}

/** Called synchronously after kernel authorization and lease expiry handling. */
export function mutateWork(state: WorkflowView, task: TaskView, attemptId: string,
  method: string, args: Record<string, unknown>, now: number): unknown {
  if (!task.agentId) throw new Error('Work claims require a persistent member');
  const allowed: Record<string, string[]> = {
    claim_work: ['leaseMs', 'queue'], checkpoint_work: ['expectedProgressVersion', 'state'],
    complete_work: ['result'], fail_work: ['error', 'retry'], release_claim: ['reason', 'waitFor'],
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
    const held = claims.find(claim => claim.status === 'active' && !claim.landing && claim.agentId === task.agentId);
    if (held && (held.taskId !== task.taskId || held.attemptId !== attemptId)) throw new Error('Member has a claim in another attempt');
    if (held && (itemById(state, held.itemId).queue ?? 'default') !== name) throw new Error('Member already has a claim in another queue');
    let claim: Pick<WorkClaim, 'id' | 'generation'> | undefined = held;
    if (!claim) {
      const item = workFor(state, name, member)[0];
      if (item) {
        if (claims.length >= WORK_MAX_CLAIMS) throw new Error('Work claim history limit reached');
        const granted: WorkClaim = { id: randomUUID(), itemId: item.id, agentId: task.agentId, taskId: task.taskId, attemptId,
          generation: item.generation + 1, progress: item.progress.version, leaseUntil: Math.min(now + leaseMs, state.deadlineAt), status: 'active', createdAt: now };
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
        endClaim(state, claim, now, 'failed', scriptText(args.error, 'work error', 1000), args.retry === true, true);
        response = { itemId: item.id, status: item.status };
        break;
      }
      case 'release_claim': {
        // What the item has to wait for before anyone takes it again: named here, it is not handed straight back out.
        const waitFor = args.waitFor === undefined ? [] : dependencyKeys(args.waitFor).filter(key => key !== item.key);
        if (waitFor.some(key => !workItemByKey(state, key))) throw new Error('waitFor names existing work keys: add the item or the gate it waits for first');
        const waits = current(state, [...item.dependsOn ?? [], ...waitFor]);
        const loop = waits.find(key => { const other = workItemByKey(state, key); return other && prerequisites(state, other).has(item.key); });
        if (loop) throw new Error(`"${loop}" waits on this item, so this item cannot wait for it`);
        endClaim(state, claim, now, 'released', scriptText(args.reason, 'release reason', 1000), true);
        if (waitFor.length && waits.join('\n') !== (item.dependsOn ?? []).join('\n')) emit(state, { type: 'work_updated', itemId: item.id, dependsOn: waits, at: now });
        response = { itemId: item.id, status: item.status, ...(waitFor.length ? { waitsOn: waitsOn(state, item) } : {}) };
        break;
      }
    }
  }
  emit(state, { type: 'work_operation_recorded', operation: { key, digest, response } });
  capacity(state, args, response, key);
  return present(response);
}
