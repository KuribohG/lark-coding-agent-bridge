import type { WorkflowStore } from './kernel-store';
import type { NativeIdKind, TaskView, WorkflowHost, WorkflowLogger, WorkflowView } from './types';
import type { WorkerHosts } from './worker-hosts';

/**
 * What the kernel's collaborators share and the parts of each other they call. Collaborators reach one another
 * through this context at call time; it names only the cross-calls so that no collaborator imports another.
 * The cross-calls that change a workflow emit events and must run inside a store transaction.
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
    /** `error` records why the kernel, rather than a caller, stopped the task. */
    cancelTask(task: TaskView, state: WorkflowView, error?: string): void;
    expireClaims(state: WorkflowView): void;
  };
  readonly children: {
    executionAllowed(state: WorkflowView): boolean;
    remainingTreeTasks(state: WorkflowView): number;
    suspendChildren(state: WorkflowView, cancel: boolean, taskId?: string): void;
    runChildWorkflow(state: WorkflowView, task: TaskView, args: Record<string, unknown>): unknown;
    finishChild(state: WorkflowView): void;
  };
  readonly lifecycle: {
    hasWake(scopeId: string): boolean;
    invalidate(scopeId: string): void;
    cancelState(state: WorkflowView): void;
    pause(state: WorkflowView): void;
  };
  readonly recovery: {
    resumeClock(state: WorkflowView): void;
    /** `automatic` marks the replay after a restart, which does not count against the replay limit. */
    replayScript(state: WorkflowView, args: Record<string, unknown>, automatic?: boolean): void;
  };
  readonly scripts: {
    checkWorkKey(state: WorkflowView, value: unknown, operation?: 'enqueue' | 'swarm' | 'close'): string;
    finishScript(scopeId: string, workflowId: string, runId: string, result: { text: string } | { error: string }): void;
  };
}
