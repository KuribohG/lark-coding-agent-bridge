import type { WorkflowState } from './types';

export interface WorkspaceBinding {
  id: string;
  workflowId: string;
  rootDigest: string;
  repository: string;
  commonDir: string;
  path: string;
  baseCommit: string;
  kind: 'task' | 'review' | 'integration';
  changeId?: string;
  status: 'preparing' | 'ready' | 'removed';
  busy?: { token: string; taskId?: string; ownerPid: number };
}

export interface WorkspaceChange {
  id: string;
  workspaceId: string;
  baseCommit: string;
  headCommit: string;
  tree: string;
  diffDigest: string;
  files: string[];
}

export interface WorkspaceApproval {
  id: string;
  changeId: string;
  taskId: string;
  resultRef: string;
}

export interface WorkspaceChecks {
  id: string;
  workspaceId: string;
  headCommit: string;
  tree: string;
  passed: boolean;
  commands: Array<{ argv: string[]; code: number; stdout: string; stderr: string }>;
}

export interface WorkspaceIntegration {
  workspace: WorkspaceBinding;
  status: 'prepared' | 'conflict';
  approvals: string[];
  remaining: string[];
  targetRef: string;
  expectedHead: string | null;
  headCommit: string;
  conflict?: string;
}

export type WorkspaceCommands = Array<{ argv: string[]; timeoutMs: number }>;

/**
 * How members land work with submit_work: the private branch that collects it and what every landing must pass.
 * Submissions are landed in batches: a train stacks the waiting ones in its own worktree, checks the stack once and
 * advances the branch to it, so the commit that lands is always one the checks passed on.
 */
export interface WorkspaceLanding {
  targetRef: string;
  /** Run on each train, in the train's worktree. */
  commands: WorkspaceCommands;
  /** Run in the member's worktree before its submission may board a train. */
  precheck?: WorkspaceCommands;
  /** Paths a submission may not change, unless it comes from one of the rule's `allow` worktrees. */
  protect?: Array<{ paths: string[]; allow: string[] }>;
  /** Submissions one train carries at most. */
  batch: number;
}

export type LandReport =
  /** The branch head now contains the work, and the worktree was moved to it. */
  | { status: 'landed'; targetRef: string; headCommit: string; commits: number }
  /** The commits do not apply to `targetCommit`; the worktree holds them as submitted. */
  | { status: 'conflict'; targetRef: string; targetCommit: string; detail: string }
  /** The worktree is left with the commits that failed, on top of `targetCommit`. */
  | { status: 'check_failed'; targetRef: string; targetCommit: string; headCommit: string; reason?: string; commands: WorkspaceChecks['commands'] }
  /** The commits change protected paths; the worktree is left rebased onto `targetCommit`. */
  | { status: 'rejected'; targetRef: string; targetCommit: string; files: string[]; reason: string };

export interface WorkspaceContext {
  state: WorkflowState;
  signal: AbortSignal;
}
