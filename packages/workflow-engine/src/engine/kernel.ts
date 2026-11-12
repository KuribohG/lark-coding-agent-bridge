import { silentLogger } from './ports';
import { ChildWorkflows } from './kernel-children';
import type { KernelContext } from './kernel-context';
import { WorkflowLifecycle } from './kernel-lifecycle';
import { KernelOperations } from './kernel-operations';
import { RestartRecovery } from './kernel-recovery';
import { WorkflowScheduler } from './kernel-scheduler';
import { ScriptApi } from './kernel-script-api';
import { settleEventWaits } from './event-waits';
import { BUSY } from './kernel-state';
import { WorkflowStore } from './kernel-store';
import type { NativeIdKind, WorkflowCaller, WorkflowHost, WorkflowLogger, WorkflowState, WorkflowView } from './types';
import { WorkerHosts, type WorkerHostRecord } from './worker-hosts';

export { RESUME_DEADLINE, RESUME_ROOT_CHANGED } from './kernel-recovery';

/** Concrete wiring of KernelContext. Collaborators keep a reference and call each other only at call time. */
class KernelParts implements KernelContext {
  closed = false;
  readonly store: WorkflowStore;
  readonly hosts: WorkerHosts;
  readonly scheduler: WorkflowScheduler;
  readonly children: ChildWorkflows;
  readonly lifecycle: WorkflowLifecycle;
  readonly recovery: RestartRecovery;
  readonly scripts: ScriptApi;
  readonly operations: KernelOperations;

  constructor(path: string, readonly host: WorkflowHost, readonly now: () => number) {
    // Whatever an operation changed, the waits it satisfied settle in the same commit.
    this.store = new WorkflowStore(path, now, {
      policy: state => { settleEventWaits(state, now()); },
      // A host listener that throws must not make a committed operation look failed to its caller.
      listenerFailed: error => this.log.warn('change-listener-failed', { error: String(error) }),
      backgroundCheckpoint: true,
      checkpointFailed: error => this.log.warn('background-checkpoint-unavailable', { error: String(error) }),
    });
    this.hosts = new WorkerHosts(this.store.db);
    this.scheduler = new WorkflowScheduler(this);
    this.children = new ChildWorkflows(this);
    this.lifecycle = new WorkflowLifecycle(this);
    this.recovery = new RestartRecovery(this);
    this.scripts = new ScriptApi(this);
    this.operations = new KernelOperations(this);
  }

  get log(): WorkflowLogger { return this.host.log ?? silentLogger; }

  nativeIdKind(agentKind: string): NativeIdKind {
    return this.host.nativeIdKind?.(agentKind) ?? 'sessionId';
  }
}

/**
 * Bridge-owned state. No model or CLI process opens this database.
 * The kernel is a facade over the collaborators wired in KernelParts. Workflow states it returns are detached copies
 * in the public shape; the live in-memory states stay inside the engine.
 */
export class WorkflowKernel {
  private readonly ctx: KernelParts;

  constructor(path: string, host: WorkflowHost, now = Date.now) {
    this.ctx = new KernelParts(path, host, now);
    const legacy = this.ctx.store.legacyUnfinished();
    if (legacy) this.ctx.log.warn('legacy-workflows-ignored', { count: legacy });
    this.ctx.recovery.retireInterrupted();
  }

  private copy(state: WorkflowView | undefined): WorkflowState | undefined {
    return state && this.ctx.store.public(state);
  }

  state(scopeId: string, workflowId?: string): WorkflowState | undefined {
    return this.copy(this.ctx.store.state(scopeId, workflowId));
  }

  context(scopeId: string): string {
    const state = this.ctx.store.state(scopeId);
    return state
      ? `${state.definition.mainInstructions}\n<workflow_context source="bridge">\n${JSON.stringify(this.ctx.operations.summary(state))}\n</workflow_context>`
      : '当前没有绑定工作流；仅 /workflow start 或 /workflow script 命令授权的本轮可调用 run_script。';
  }

  latest(scopeId: string): WorkflowState | undefined {
    return this.copy(this.ctx.store.latest(scopeId));
  }

  call(caller: WorkflowCaller, method: string, args: Record<string, unknown>): Promise<unknown> {
    return this.ctx.operations.call(caller, method, args);
  }

  waitingForChild(scopeId: string, workflowId: string, taskId: string, attemptId: string): boolean {
    return this.ctx.children.waitingForChild(scopeId, workflowId, taskId, attemptId);
  }

  /** Any committed change to a workflow of this scope. */
  onChange(scopeId: string, listener: () => void): () => void {
    return this.ctx.store.onChange(scopeId, listener);
  }

  /** Committed changes of one workflow on the given topics: `task:<id>`, `wait:<id>`, `pool`, `mailbox`, `lifecycle`. */
  watch(workflowId: string, topics: string[], listener: () => void): () => void {
    return this.ctx.store.watch(workflowId, topics, listener);
  }

  /** Every commit that changed a workflow. */
  onCommit(listener: () => void): () => void {
    return this.ctx.store.onCommit(listener);
  }

  /** Unfinished work, for host idle checks: scripts queued or running and tasks still executing. */
  activity(): { scripts: number; tasks: number } {
    let scripts = 0, tasks = 0;
    for (const state of this.ctx.store.list()) {
      if (state.status === 'active' && ['queued', 'running'].includes(state.script?.status ?? '')) scripts++;
      tasks += state.tasks.filter(task => BUSY.has(task.status)).length;
    }
    return { scripts, tasks };
  }

  queuedScripts(): WorkflowState[] {
    return this.ctx.scripts.queuedScripts().map(state => this.ctx.store.public(state));
  }

  beginScript(scopeId: string, workflowId: string): { state: WorkflowState; source: string } | undefined {
    return this.ctx.scripts.beginScript(scopeId, workflowId);
  }

  /** Whether this run of the workflow's script is still the one executing. */
  scriptRunning(scopeId: string, workflowId: string, runId: string): boolean {
    const state = this.ctx.store.state(scopeId, workflowId);
    return state?.status === 'active' && state.script?.status === 'running' && state.script.runId === runId;
  }

  scriptAgent(scopeId: string, workflowId: string, runId: string, input: unknown, managed = false): Promise<{ taskId: string; output: 'text' | 'json' }> {
    return this.ctx.scripts.scriptAgent(scopeId, workflowId, runId, input, managed);
  }

  scriptWorkspace(scopeId: string, workflowId: string, runId: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    return this.ctx.scripts.scriptWorkspace(scopeId, workflowId, runId, input, signal);
  }

  scriptControl(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<{ kind: string; taskId?: string; output?: 'text' | 'json'; waitId?: string }> {
    return this.ctx.scripts.scriptControl(scopeId, workflowId, runId, input);
  }

  scriptControlResult(scopeId: string, workflowId: string, runId: string, call: { kind: string; taskId?: string; waitId?: string }): unknown | undefined {
    return this.ctx.scripts.scriptControlResult(scopeId, workflowId, runId, call);
  }

  scriptWork(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<unknown> {
    return this.ctx.scripts.scriptWork(scopeId, workflowId, runId, input);
  }

  scriptSwarmResult(scopeId: string, workflowId: string, runId: string, key: string): unknown | undefined {
    return this.ctx.scripts.scriptSwarmResult(scopeId, workflowId, runId, key);
  }

  scriptMailbox(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<{ receiptId?: string; result?: unknown }> {
    return this.ctx.scripts.scriptMailbox(scopeId, workflowId, runId, input);
  }

  scriptMailboxResult(scopeId: string, workflowId: string, runId: string, receiptId: string): unknown[] | undefined {
    return this.ctx.scripts.scriptMailboxResult(scopeId, workflowId, runId, receiptId);
  }

  scriptTaskResult(scopeId: string, workflowId: string, runId: string, taskId: string): string | undefined {
    return this.ctx.scripts.scriptTaskResult(scopeId, workflowId, runId, taskId);
  }

  scriptProgress(scopeId: string, workflowId: string, runId: string, kind: 'phase' | 'log', text: string): void {
    this.ctx.scripts.scriptProgress(scopeId, workflowId, runId, kind, text);
  }

  finishScript(scopeId: string, workflowId: string, runId: string, result: { text: string } | { error: string }): void {
    this.ctx.scripts.finishScript(scopeId, workflowId, runId, result);
  }

  plan(scopeId: string, workflowId?: string): string {
    return this.ctx.scripts.plan(scopeId, workflowId);
  }

  /** Replays root scripts that a restart interrupted mid-run; anything else still waits for an explicit replay. */
  resumeAfterRestart(): Promise<Array<{ state: WorkflowState; resumed: boolean; reason?: string }>> {
    return this.ctx.recovery.resumeAfterRestart();
  }

  hasWake(scopeId: string): boolean {
    return this.ctx.lifecycle.hasWake(scopeId);
  }

  markNotified(scopeId: string, ids: string[]): void {
    this.ctx.lifecycle.markNotified(scopeId, ids);
  }

  invalidate(scopeId: string): void {
    this.ctx.lifecycle.invalidate(scopeId);
  }

  cancel(scopeId: string): boolean {
    return this.ctx.lifecycle.cancel(scopeId);
  }

  tick(): Promise<void> {
    return this.ctx.scheduler.tick();
  }

  /** Admission between ticks (see WorkflowScheduler.admitReady). True when a tick is needed first. */
  admitReady(): boolean {
    return this.ctx.scheduler.admitReady();
  }

  /** A running worker produced output; `busy` means a tool is in flight and silence is expected. */
  noteWorkerActivity(taskId: string, attemptId: string, busy: boolean): void {
    this.ctx.scheduler.noteActivity(taskId, attemptId, busy);
  }

  /** A process a previous controller left running for this turn. */
  workerHost(workflowId: string, match: string): WorkerHostRecord | undefined {
    return this.ctx.hosts.find(workflowId, match);
  }

  putWorkerHost(record: Omit<WorkerHostRecord, 'discard'>): void {
    if (this.ctx.closed) throw new Error('Workflow service is closed');
    this.ctx.hosts.put(record);
  }

  removeWorkerHost(hostKey: string): void {
    if (!this.ctx.closed) this.ctx.hosts.remove(hostKey);
  }

  /** Hosted processes no turn of this controller runs or can still continue. */
  orphanWorkerHosts(): WorkerHostRecord[] {
    if (this.ctx.closed) return [];
    return this.ctx.hosts.list().filter(record => {
      if (this.ctx.scheduler.isRunning(record.taskId)) return false;
      if (record.discard) return true;
      const parsed = this.ctx.store.byId(record.workflowId);
      // A replay that is still running may yet reach the call; anything else has nobody left to attach.
      return parsed?.status !== 'active' || !['queued', 'running'].includes(parsed.script?.status ?? '');
    });
  }

  beginShutdown(): void {
    this.ctx.closed = true;
    this.ctx.scheduler.abortAll('shutdown');
  }

  async close(): Promise<void> {
    this.beginShutdown();
    await this.ctx.scheduler.settled();
    this.ctx.store.close();
  }
}
