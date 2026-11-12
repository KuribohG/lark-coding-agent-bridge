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

/** How members land work with submit_work: the private branch that collects it and the checks every landing must pass. */
export interface WorkspaceLanding {
  targetRef: string;
  /** Checks must have passed on the exact commit that lands; otherwise a clean rebase after passing checks is enough. */
  strict: boolean;
  commands: Array<{ argv: string[]; timeoutMs: number }>;
}

export type LandReport =
  | { status: 'landed'; targetRef: string; headCommit: string; commits: number }
  /** The rebase onto `targetCommit` was undone; the worktree holds the member's commits as submitted. */
  | { status: 'conflict'; targetRef: string; targetCommit: string; detail: string }
  /** The worktree is left rebased onto `targetCommit`. */
  | { status: 'check_failed'; targetRef: string; targetCommit: string; headCommit: string; reason?: string; commands: WorkspaceChecks['commands'] };

export interface WorkspaceContext {
  state: WorkflowState;
  signal: AbortSignal;
}
