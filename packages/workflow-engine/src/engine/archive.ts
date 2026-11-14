import { emit } from './kernel-store';
import { CALL_KINDS, callRecordId, type CallList, type RecordKind } from './records';
import type { TaskView, WorkflowView } from './types';

/**
 * How long a finished task stays in the state. Status views list recent tasks from the state, and a script may
 * hand a task it has just awaited to a workspace review, which reads a copy of the state.
 */
export const ARCHIVE_AFTER_MS = 10 * 60_000;
/** Fewest tasks one archive pass moves; fewer wait for the next pass. */
const ARCHIVE_BATCH = 64;

/**
 * Whether a task can no longer change. A successful task never runs again. A failed or cancelled one-shot task is
 * not reused either: a replay creates a new task for its call. Failed turns of members, of task handles and of
 * workflow-enabled agents stay, because a replay continues the same task. So do one-shot tasks that ran in a managed
 * workspace: approving a review reads the reviewer's task from the state.
 */
function settled(task: TaskView): boolean {
  if (task.workspaceId && !task.agentId) return false;
  if (task.status === 'result_ready') return true;
  return (task.status === 'failed' || task.status === 'cancelled') && !task.agentId && !task.scriptManaged && !task.workflowTool;
}

/**
 * Moves long-finished tasks out of the state, so the state holds the work in flight and a recent window whatever
 * the number of tasks the workflow has run. A member's latest turns, a turn its swarm still points at, tasks a
 * notice or a pending wait refers to all stay.
 */
export function archiveFinished(state: WorkflowView, now: number, after = ARCHIVE_AFTER_MS, batch = ARCHIVE_BATCH): number {
  if (state.tasks.length < batch) return 0;
  const pinned = new Set<string | undefined>();
  for (const agent of state.agents ?? []) { pinned.add(agent.activeTurnId); pinned.add(agent.lastTurnId); }
  for (const swarm of state.swarms ?? []) for (const member of swarm.members) pinned.add(member.taskId);
  for (const notice of state.events) if (!notice.acknowledged) pinned.add(notice.taskId);
  for (const wait of state.waits ?? []) if (wait.status === 'waiting') for (const arm of wait.any) if (arm.kind === 'task') pinned.add(arm.taskId);
  const tasks = state.tasks.filter(task => settled(task) && !pinned.has(task.taskId) && (task.attempts.at(-1)?.endedAt ?? 0) <= now - after);
  if (tasks.length < batch) return 0;
  const taskIds = new Set(tasks.map(task => task.taskId));
  emit(state, { type: 'tasks_archived', taskIds: [...taskIds],
    // A one-shot task owns its session; a member's session outlives its turns.
    sessionRefs: tasks.filter(task => !task.agentId).map(task => task.sessionRef),
    artifactRefs: state.artifacts.filter(artifact => artifact.taskId !== undefined && taskIds.has(artifact.taskId)).map(artifact => artifact.ref) });
  return tasks.length;
}

/** Entries of an idempotency or feed list that stay in the state; lookups of older ones read the archive. */
export const KEEP_RECENT = 256;

/**
 * Moves the settled entries of the workflow's other lists out of the state (see records.ts): old board posts,
 * consumed messages and receipts, finished work items and claims, settled waits, acknowledged notices, and all but
 * the latest idempotency records and script keys. What may still change stays: unread messages, open receipts,
 * pending, claimed and failed work items, items an unfinished item depends on, active claims and open waits.
 */
export function archiveRecords(state: WorkflowView, now: number, after = ARCHIVE_AFTER_MS, batch = ARCHIVE_BATCH): number {
  let moved = 0;
  const archive = (kind: RecordKind, ids: string[]) => {
    if (ids.length < batch) return;
    emit(state, { type: 'records_archived', kind, ids });
    moved += ids.length;
  };
  const old = (at: number | undefined) => (at ?? 0) <= now - after;
  /** Everything before the latest KEEP_RECENT entries. */
  const older = <T>(list: ReadonlyArray<T> | undefined, id: (entry: T) => string) => (list ?? []).slice(0, Math.max(0, (list?.length ?? 0) - KEEP_RECENT)).map(id);

  // Posts are archived as a prefix of the feed, so a post's place in the state follows from its seq.
  archive('post', older(state.board?.posts, post => String(post.seq)));
  archive('message', (state.mailbox?.messages ?? []).filter(message => message.consumedByTurnId && old(message.createdAt)).map(message => message.id));
  archive('receipt', (state.mailbox?.receipts ?? []).filter(receipt => receipt.status === 'consumed').map(receipt => receipt.id));
  archive('mailboxOperation', older(state.mailbox?.operations, operation => operation.key));

  const work = state.workQueue;
  if (work) {
    const needed = new Set(work.items.filter(item => item.status !== 'completed' && item.status !== 'cancelled').flatMap(item => item.dependsOn ?? []));
    archive('workItem', work.items.filter(item => (item.status === 'completed' || item.status === 'cancelled') && !needed.has(item.key) && old(item.updatedAt)).map(item => item.id));
    archive('claim', work.claims.filter(claim => claim.status !== 'active' && old(claim.endedAt)).map(claim => claim.id));
    archive('workOperation', older(work.operations, operation => operation.key));
  }

  const bound = new Set((state.agents ?? []).flatMap(agent => agent.wait?.kind === 'event' ? [agent.wait.receiptId] : []));
  archive('wait', (state.waits ?? []).filter(wait => wait.status === 'ready' && !bound.has(wait.id) && old(wait.createdAt)).map(wait => wait.id));
  archive('controlOperation', older(state.controlOperations, operation => operation.key));
  archive('workspaceKey', older(state.workspaceKeys, key => key));
  archive('notice', state.events.filter(notice => notice.acknowledged && old(notice.acknowledgedAt)).map(notice => notice.id));
  archive('direct', older(state.direct, message => message.id));
  const { script } = state;
  if (script) for (const list of Object.keys(CALL_KINDS) as CallList[]) archive(CALL_KINDS[list], older(script[list], key => callRecordId(script, key)));
  return moved;
}
