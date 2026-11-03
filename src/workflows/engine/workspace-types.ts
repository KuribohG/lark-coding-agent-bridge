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

export interface WorkspaceContext {
  state: WorkflowState;
  signal: AbortSignal;
}
