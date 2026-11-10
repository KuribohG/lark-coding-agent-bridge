import type { KernelContext } from '../kernel-context';
import type { WorkflowCaller, WorkflowRoot, WorkflowState, WorkflowTask } from '../types';

export type ScriptState = WorkflowState & { script: NonNullable<WorkflowState['script']> };
export type ToolArgs = Record<string, unknown>;
export type WorkerCaller = Extract<WorkflowCaller, { kind: 'worker' }>;

/** Commits the operation with its idempotency record; `response` runs after the state change is final. */
export type CommitOperation = (response: () => unknown) => unknown;

/**
 * A main-agent operation. `read` needs no operationId and may run without a bound workflow; `start` creates the
 * workflow; `mutate` is a versioned, idempotent change that passes the kernel's root, status and deadline checks.
 */
export type MainTool =
  | { kind: 'read'; read(ctx: KernelContext, state: WorkflowState | undefined, args: ToolArgs): unknown }
  | { kind: 'start'; start(ctx: KernelContext, root: WorkflowRoot, args: ToolArgs): WorkflowState }
  | {
    kind: 'mutate';
    /** Skip the root, status and deadline checks; only terminal workflows are refused. */
    terminalCheckOnly?: boolean;
    /** Restart the paused clock before status checks. */
    resumesClock?: boolean;
    allowInterrupted?: boolean;
    allowAfterDeadline?: boolean;
    apply(ctx: KernelContext, state: ScriptState, args: ToolArgs, commit: CommitOperation): unknown;
  };

/** A worker operation, called after the kernel has checked that the caller's attempt and member turn are active. */
export interface WorkerTool {
  /** Re-resolve the root session first; required for operations that change shared state. */
  verifiesRoot?: boolean;
  /** Runs before the attempt binding check, for example to expire stale leases the binding check depends on. */
  prepare?(ctx: KernelContext, state: WorkflowState): void;
  call(ctx: KernelContext, state: WorkflowState, task: WorkflowTask, caller: WorkerCaller, args: ToolArgs): unknown;
}

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
