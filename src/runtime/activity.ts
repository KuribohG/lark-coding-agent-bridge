/** Unchanged activity is still rewritten this often, so readers can detect a stalled publisher. */
export const ACTIVITY_HEARTBEAT_MS = 30_000;

/** What a profile is doing right now; published to the process registry for `bridge status`. */
export interface RuntimeActivity {
  /** Agent executions, including document-comment runs. */
  runs: number;
  /** Conversation turns, from batch preparation through reply delivery. */
  turns: number;
  /** Messages received but not yet handed to a turn. */
  queuedMessages: number;
  sideQuestions: number;
  workflowScripts: number;
  workflowTasks: number;
  newRunsPaused: boolean;
}

export function isIdleActivity(activity: RuntimeActivity): boolean {
  return activity.runs + activity.turns + activity.queuedMessages + activity.sideQuestions
    + activity.workflowScripts + activity.workflowTasks === 0;
}

export function isRuntimeActivity(value: unknown): value is RuntimeActivity {
  if (!value || typeof value !== 'object') return false;
  const x = value as Record<string, unknown>;
  return ['runs', 'turns', 'queuedMessages', 'sideQuestions', 'workflowScripts', 'workflowTasks']
    .every(key => typeof x[key] === 'number') && typeof x.newRunsPaused === 'boolean';
}
