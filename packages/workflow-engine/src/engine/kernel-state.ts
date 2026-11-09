import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import type { WorkflowArtifact, WorkflowEvent, WorkflowRoot, WorkflowState, WorkflowTask } from './types';

/** Shared state helpers for the kernel's collaborators; none of them touch the database. */

export const BUSY = new Set<WorkflowTask['status']>(['queued', 'starting', 'running', 'cancelling']);
export const MAX_TEXT = 100_000;

// The main session's model settings may change mid-run; workers resolve against the pinned start-time root.
function rootBinding({ modelSettings: _modelSettings, ...binding }: WorkflowRoot): Omit<WorkflowRoot, 'modelSettings'> { return binding; }
export function sameRoot(a: WorkflowRoot, b: WorkflowRoot): boolean { return workflowDigest(rootBinding(a)) === workflowDigest(rootBinding(b)); }
export function requireState(state: WorkflowState | undefined): WorkflowState {
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
export function acknowledge(event: WorkflowEvent, now: number): void {
  if (event.acknowledged) return;
  event.acknowledged = true;
  event.acknowledgedAt = now;
}

export function findTask(state: WorkflowState, id: string): WorkflowTask {
  const task = state.tasks.find(item => item.taskId === id);
  if (!task) throw new Error('Task not found in workflow');
  return task;
}

export function readArtifact(state: WorkflowState, ref: string): WorkflowArtifact {
  const artifact = state.artifacts.find(item => item.ref === ref);
  if (!artifact) throw new Error('Artifact not found in workflow');
  if (workflowDigest(artifact.text) !== artifact.digest) throw new Error('Artifact digest mismatch');
  return artifact;
}

export function addArtifact(state: WorkflowState, kind: string, text: string, now: () => number, task?: WorkflowTask): WorkflowArtifact {
  const artifact: WorkflowArtifact = { ref: `artifact:${randomUUID()}`, kind, text, digest: workflowDigest(text), createdAt: now(),
    ...(task ? { taskId: task.taskId, attemptId: task.attempts.at(-1)?.attemptId } : {}) };
  state.artifacts.push(artifact);
  return artifact;
}

export function pushEvent(state: WorkflowState, event: Omit<WorkflowEvent, 'id' | 'acknowledged' | 'notified'>, now: () => number): void {
  state.events.push({ ...event, id: randomUUID(), acknowledged: false, notified: false, createdAt: now() });
}
