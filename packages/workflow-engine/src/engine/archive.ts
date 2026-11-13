import { emit } from './kernel-store';
import type { TaskView, WorkflowView } from './types';

/**
 * How long a finished task stays in the state. Status views list recent tasks from the state, and a script may
 * hand a task it has just awaited to a workspace review, which reads a copy of the state.
 */
export const ARCHIVE_AFTER_MS = 10 * 60_000;
/** Fewest tasks one archive pass moves; fewer wait for the next pass. */
export const ARCHIVE_BATCH = 64;

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
