import type { KernelContext } from '../kernel-context';
import type { TaskView, WorkflowCaller, WorkflowRoot, WorkflowView } from '../types';

export type ScriptState = WorkflowView & { script: NonNullable<WorkflowView['script']> };
export type ToolArgs = Record<string, unknown>;
export type WorkerCaller = Extract<WorkflowCaller, { kind: 'worker' }>;

/** Records the operation's idempotent response; `response` runs once the state version of this change is final. */
export type CommitOperation = (response: () => unknown) => unknown;

/**
 * A main-agent operation. `read` needs no operationId and may run without a bound workflow; `start` creates the
 * workflow; `mutate` is a versioned, idempotent change that passes the kernel's root, status and deadline checks.
 * `start`, `mutate` and worker calls run inside one store transaction and change state by emitting events.
 */
export type MainTool =
  | { kind: 'read'; read(ctx: KernelContext, state: WorkflowView | undefined, args: ToolArgs): unknown }
  | { kind: 'start'; start(ctx: KernelContext, root: WorkflowRoot, args: ToolArgs): WorkflowView }
  /** Acts on something outside the store, such as a running worker; `change` opens a transaction on the current state. */
  | { kind: 'direct'; run(ctx: KernelContext, state: WorkflowView, args: ToolArgs, change: <T>(apply: (state: WorkflowView) => T) => T): Promise<unknown> }
  | {
    kind: 'mutate';
    /** Skip the root, status and deadline checks; only terminal workflows are refused. */
    terminalCheckOnly?: boolean;
    /** Restart the paused clock before status checks. */
    resumesClock?: boolean;
    allowInterrupted?: boolean;
    allowAfterDeadline?: boolean;
    /**
     * The change only adds to the workflow (a work item, a post, a message) and commutes with every concurrent change,
     * so it is not checked against `expectedStateVersion`. The workflow has one version that every worker and
     * scheduler commit advances; a main agent that had to read it first could not land a change on a busy workflow.
     * The operationId still makes a retry idempotent.
     */
    appendOnly?: boolean;
    /**
     * Awaits what the change needs from the host, such as the execution binding of a new member, before the
     * transaction opens. `state` is the workflow as it was then; `apply` receives the value and checks the current one.
     */
    resolve?(ctx: KernelContext, state: ScriptState, args: ToolArgs): Promise<unknown>;
    apply(ctx: KernelContext, state: ScriptState, args: ToolArgs, commit: CommitOperation, resolved?: unknown): unknown;
  };

/** A worker operation, called after the kernel has checked that the caller's attempt and member turn are active. */
export interface WorkerTool {
  /** Re-resolve the root session first; required for operations that change shared state. */
  verifiesRoot?: boolean;
  /** Runs before the attempt binding check, for example to expire stale leases the binding check depends on. */
  prepare?(ctx: KernelContext, state: WorkflowView): void;
  call(ctx: KernelContext, state: WorkflowView, task: TaskView, caller: WorkerCaller, args: ToolArgs): unknown;
  /**
   * Replaces `call` for an operation that waits on work outside the store, such as Git commands. It runs outside any
   * transaction and reads or changes the workflow through `bound`, which opens a transaction after repeating the
   * check that the caller's attempt and member turn are still active.
   */
  run?(ctx: KernelContext, caller: WorkerCaller, args: ToolArgs, bound: BoundCall): Promise<unknown>;
}

export type BoundCall = <T>(change: (state: WorkflowView, task: TaskView) => T) => T;

export interface WorkflowTool {
  name: string;
  main?: MainTool & { doc: string };
  worker?: WorkerTool;
}

/**
 * A group of related workflow tools with the instructions that teach models to use them. Agents only learn a tool
 * from these texts, so a tool's behaviour and its description live in the same plugin.
 */
export interface WorkflowToolPlugin {
  id: string;
  tools: readonly WorkflowTool[];
  /** Paragraph for persistent members, in plugin order. */
  memberInstructions?: string;
  /** Paragraph for workers that may start child workflows. */
  nestedInstructions?: string;
}
