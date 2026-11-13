import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { byId } from './evolve';
import { archiveOf, emit, putText, readText } from './kernel-store';
import type { ArtifactView, Immutable, StoredArtifact, TaskView, WorkflowArtifact, WorkflowEvent, WorkflowRoot, WorkflowTask, WorkflowView } from './types';

/** Shared state helpers for the kernel's collaborators. Changes are recorded as events inside a store transaction. */

export const BUSY = new Set<WorkflowTask['status']>(['queued', 'starting', 'running', 'cancelling']);
export const MAX_TEXT = 100_000;

// The main session's model settings may change mid-run; workers resolve against the pinned start-time root.
function rootBinding({ modelSettings: _modelSettings, ...binding }: Immutable<WorkflowRoot>): Omit<Immutable<WorkflowRoot>, 'modelSettings'> { return binding; }
export function sameRoot(a: Immutable<WorkflowRoot>, b: Immutable<WorkflowRoot>): boolean { return workflowDigest(rootBinding(a)) === workflowDigest(rootBinding(b)); }
export function requireState(state: WorkflowView | undefined): WorkflowView {
  if (!state) throw new Error('Workflow not found in current root scope');
  return state;
}
export function requiredText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Expected nonempty string of at most ${max} characters`);
  return value;
}
export function optionalText(value: unknown): string | undefined { return value === undefined ? undefined : requiredText(value, 200); }
export function textArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Expected bounded string array');
  return value.map(item => requiredText(item));
}

export function taskById(state: WorkflowView, id: string | undefined): TaskView | undefined {
  return byId(state.tasks, task => task.taskId, id);
}

/** A task still in the state. Only these can change, so code that goes on to emit events for a task looks it up here. */
export function findTask(state: WorkflowView, id: string): TaskView {
  const task = taskById(state, id);
  if (!task) throw new Error('Task not found in workflow');
  return task;
}

/** A task in the state or the archive; an archived task is finished and will not change. */
export function anyTask(state: WorkflowView, id: string | undefined): TaskView | undefined {
  return taskById(state, id) ?? (id === undefined ? undefined : archiveOf(state)?.task(id));
}

/** Agent calls the current script run has made, archived ones included. */
export function callCount(state: WorkflowView): number {
  return state.script!.calls.length + (state.script!.archivedCalls ?? 0);
}

/** A call of the current script run by its key or by the task that answered it. */
export function scriptCall(state: WorkflowView, by: { key: string } | { taskId: string }): Immutable<{ key: string; taskId: string }> | undefined {
  const script = state.script!;
  return script.calls.find(call => 'key' in by ? call.key === by.key : call.taskId === by.taskId)
    ?? (script.archivedCalls ? archiveOf(state)?.call(script.runId, by) : undefined);
}

/** Whether any task of the workflow was created under this script key. */
export function taskKeyUsed(state: WorkflowView, key: string): boolean {
  return state.tasks.some(task => task.scriptKey === key) || Boolean(archiveOf(state)?.hasKey(key));
}

/** Records a call of the current run; a call answered by an archived task is counted without entering the state. */
export function recordCall(state: WorkflowView, key: string, task: TaskView, cached: boolean): void {
  if (taskById(state, task.taskId)) emit(state, { type: 'script_call_recorded', call: { key, taskId: task.taskId, cached } });
  else emit(state, { type: 'script_call_archived', call: { key, taskId: task.taskId, ...(task.agentId ? { agentId: task.agentId } : {}) } });
}

/** Tasks the workflow has created, archived ones included. */
export function taskCount(state: WorkflowView): number {
  return state.tasks.length + (state.archived?.tasks ?? 0);
}

export function acknowledge(state: WorkflowView, events: ReadonlyArray<Immutable<WorkflowEvent>>, now: number): void {
  const ids = events.filter(event => !event.acknowledged).map(event => event.id);
  if (ids.length) emit(state, { type: 'notices_acknowledged', ids, at: now });
}

export function artifactOf(state: WorkflowView, ref: string): ArtifactView {
  const artifact = byId(state.artifacts, item => item.ref, ref) ?? archiveOf(state)?.artifact(ref);
  if (!artifact) throw new Error('Artifact not found in workflow');
  return artifact;
}

/** The artifact with its text, in the shape callers outside the kernel receive. */
export function readArtifact(state: WorkflowView, ref: string): WorkflowArtifact {
  const { chars: _chars, ...artifact } = artifactOf(state, ref);
  const text = readText(state, artifact);
  if (workflowDigest(text) !== artifact.digest) throw new Error('Artifact digest mismatch');
  return { ...artifact, text };
}

export function addArtifact(state: WorkflowView, kind: string, text: string, now: () => number, task?: TaskView, extra?: { truncated?: boolean }): StoredArtifact {
  const artifact: StoredArtifact = { ref: `artifact:${randomUUID()}`, kind, ...putText(state, text), createdAt: now(),
    ...(extra?.truncated ? { truncated: true } : {}),
    ...(task ? { taskId: task.taskId, attemptId: task.attempts.at(-1)?.attemptId } : {}) };
  emit(state, { type: 'artifact_added', artifact });
  return artifact;
}

export function pushEvent(state: WorkflowView, event: Omit<WorkflowEvent, 'id' | 'acknowledged' | 'notified'>, now: () => number): void {
  emit(state, { type: 'notice_raised', notice: { ...event, id: randomUUID(), acknowledged: false, notified: false, createdAt: now() } });
}
