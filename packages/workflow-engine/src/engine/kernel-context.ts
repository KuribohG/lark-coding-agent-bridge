import type { WorkflowStore } from './kernel-store';
import type { NativeIdKind, WorkflowHost, WorkflowLogger, WorkflowState, WorkflowTask } from './types';
import type { WorkerHosts } from './worker-hosts';

/**
 * What the kernel's collaborators share and the parts of each other they call. Collaborators reach one another
 * through this context at call time; it names only the cross-calls so that no collaborator imports another.
 */
export interface KernelContext {
  readonly closed: boolean;
  readonly host: WorkflowHost;
  readonly now: () => number;
  readonly log: WorkflowLogger;
  readonly store: WorkflowStore;
  readonly hosts: WorkerHosts;
  nativeIdKind(agentKind: string): NativeIdKind;
  readonly scheduler: {
    cancelTask(task: WorkflowTask, state: WorkflowState): void;
    expireClaims(state: WorkflowState): void;
  };
  readonly children: {
    executionAllowed(state: WorkflowState): boolean;
    remainingTreeTasks(state: WorkflowState): number;
    suspendChildren(state: WorkflowState, cancel: boolean, taskId?: string): void;
    runChildWorkflow(state: WorkflowState, task: WorkflowTask, args: Record<string, unknown>): unknown;
    finishChild(state: WorkflowState): void;
  };
  readonly lifecycle: {
    hasWake(scopeId: string): boolean;
    invalidate(scopeId: string): void;
    cancelState(state: WorkflowState): void;
    pause(state: WorkflowState): void;
  };
  readonly recovery: {
    resumeClock(state: WorkflowState): void;
    replayScript(state: WorkflowState, args: Record<string, unknown>): void;
  };
  readonly scripts: {
    checkWorkKey(state: WorkflowState, value: unknown, operation?: 'enqueue' | 'consume' | 'close'): string;
    finishScript(scopeId: string, workflowId: string, runId: string, result: { text: string } | { error: string }): void;
  };
}
