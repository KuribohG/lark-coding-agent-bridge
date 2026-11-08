import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { NativeIdKind, WorkerExecution, WorkflowLogger, WorkflowRoot, WorkflowStopReason } from './types';

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
  | { type: 'final_text'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; normal: boolean }
  | { type: 'user_input'; question: string };

export interface WorkerRun {
  runId: string;
  events(): AsyncIterable<WorkerRunEvent>;
  result: Promise<'completed' | 'stopped' | 'failed'>;
  stop(reason: WorkflowStopReason): Promise<void>;
  /** Resolves false when native process exit cannot be confirmed in time. */
  waitForExit(timeoutMs: number): Promise<boolean>;
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
  /** Ends the process if it still runs and deletes its records. */
  release(key: string): Promise<void>;
}

/** Starts one agent turn. Each call is a fresh native process unless it attaches to a host; `resume` continues the native session. */
export interface WorkerRunner {
  start(spec: WorkerRunSpec): Promise<WorkerRun>;
  hosting?: WorkerHosting;
}
