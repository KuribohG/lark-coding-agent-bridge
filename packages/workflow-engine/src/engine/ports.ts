import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { NativeIdKind, WorkerExecution, WorkerInputStatus, WorkflowLogger, WorkflowRoot, WorkflowStopReason } from './types';

/** Contracts a host implements to embed the workflow engine. The engine imports nothing outside this directory. */

/** Abort reason attached to engine signals; hosts translate it into their own stop vocabulary. */
export class WorkflowStopped extends Error {
  constructor(readonly reason: WorkflowStopReason) {
    super(`Run stopped: ${reason}`);
    this.name = 'WorkflowStopped';
  }
}

export function stopReasonOf(signal: AbortSignal): WorkflowStopReason {
  return signal.reason instanceof WorkflowStopped ? signal.reason.reason : 'cancelled';
}

export const silentLogger: WorkflowLogger = { info() {}, warn() {} };

/** Process primitives for managed worktree commands. Defaults to node:child_process. */
export interface WorkflowProcesses {
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  /** Kills a child whose process group cannot be signalled (Windows). */
  killTree(child: ChildProcess): void;
}

export interface WorkerRunSpec {
  executionId: string;
  logicalCallId: string;
  attemptId: string;
  taskId?: string;
  scriptKey?: string;
  memberKey?: string;
  roleLabel?: string;
  readOnly?: boolean;
  scriptOutput?: 'text' | 'json';
  /** Host-bound direct tools; no reusable model-visible IPC credentials. */
  workflowTools?: { definitions: unknown[]; call(method: string, args: Record<string, unknown>): Promise<unknown> };
  /** Stable for one worker session across its turns. */
  sessionKey: string;
  root: WorkflowRoot;
  execution: WorkerExecution;
  role: string;
  prompt: string;
  systemPrompt: string;
  /** Workflow tool credentials; the worker process must inherit them. */
  env: Record<string, string>;
  workspace?: { id: string; path: string; rootDigest: string };
  resume?: { kind: NativeIdKind; id: string };
  /** Run under this host key (see WorkerHosting); with attach, continue the process already running there instead of starting one. */
  host?: { key: string; attach: boolean };
  deadlineAt: number;
  signal: AbortSignal;
  /** Runs after admission and before the agent starts; throws to reject a stale binding. */
  validateBeforeRun(): Promise<void>;
}

export type WorkerRunEvent =
  | { type: 'session'; nativeSessionId: string; model?: string }
  | { type: 'retry' }
  /**
   * The agent produced output; `busy` reports whether a tool call is in flight, when a tool is what keeps it silent.
   * `busyUntil` is the wall-clock time by which a call in flight is due back, for a host that knows the limits its
   * agent puts on its tools: a call still out after it is taken for hung. Without it the host's tool limit applies.
   */
  | { type: 'activity'; busy: boolean; busyUntil?: number }
  | { type: 'final_text'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; normal: boolean }
  | { type: 'user_input'; question: string };

export interface WorkerRun {
  runId: string;
  /** The process runs under the host the spec named: a 'shutdown' stop leaves it running for a later attach. */
  hosted?: boolean;
  events(): AsyncIterable<WorkerRunEvent>;
  result: Promise<'completed' | 'stopped' | 'failed' | 'unknown'>;
  /** Delivers a user message into the running turn; absent when the harness cannot take one. */
  send?(text: string, messageId: string): Promise<WorkerInputStatus>;
  stop(reason: WorkflowStopReason): Promise<void>;
  /** Resolves false when native process exit cannot be confirmed in time. */
  waitForExit(timeoutMs: number): Promise<boolean>;
  waitForQuiescence?(timeoutMs: number): Promise<{ state: 'requested' | 'quiescent' | 'unknown' }>;
  stopReason(): WorkflowStopReason | undefined;
}

/**
 * Worker processes that survive the host process. A run started with `host` must
 * keep running when stopped for 'shutdown'; a later runner.start with the same key
 * and `attach` replays its output from the beginning and continues it.
 */
export interface WorkerHosting {
  newKey(): string;
  /** True when `key` holds a process of `agentKind`, running or finished, that can be attached. */
  attachable(key: string, agentKind: string): Promise<boolean>;
  /**
   * Ends the process if it still runs and deletes its records. Resolves false when the process may still be running:
   * what it holds, such as a worktree, then stays held.
   */
  release(key: string): Promise<boolean>;
}

/**
 * Starts one agent turn. Each call is a fresh native process unless it attaches to a host; `resume` continues the native
 * session. Persistent backends may retain their session while quiescent.
 */
export interface WorkerRunner {
  start(spec: WorkerRunSpec): Promise<WorkerRun>;
  hosting?: WorkerHosting;
}
