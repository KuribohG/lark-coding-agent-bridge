import { dirname, join } from 'node:path';
import { WorkflowWorkspaces } from './workspaces';
import type { WorkspaceBinding } from './workspace-types';
import { fileURLToPath } from 'node:url';
import { silentLogger, WorkflowStopped, type WorkerRun, type WorkerRunner, type WorkflowProcesses } from './ports';
import { RESUME_DEADLINE, RESUME_ROOT_CHANGED, WorkflowKernel } from './kernel';
import { WorkflowIpc, WORKFLOW_TOOL_INSTRUCTIONS, workflowWorkerInstructions } from './ipc';
import { workflowDigest } from './digest';
import { inheritedWorkerExecution } from './execution';
import { runScriptProgram } from './script-vm';
import type { WorkerExecution, WorkerExecutionPolicy, WorkerExecutionSelection, WorkflowLogger, WorkflowRoot, WorkflowState, WorkflowWorkerRequest, WorkflowWorkerResult } from './types';

export interface WorkflowRuntimeDeps extends WorkerExecutionPolicy {
  /** SQLite path, or ':memory:' (managed worktrees then need an explicit workspaceRoot). */
  path: string;
  workspaceRoot?: string;
  runner: WorkerRunner;
  getTimeoutMinutes?(root: WorkflowRoot): number;
  /** Current authorization of a main session; undefined revokes it. Workers stop when the digest changes. */
  resolveRoot(scopeId: string): Promise<WorkflowRoot | undefined>;
  /** Defaults to inheriting the root execution, which rejects cross-harness workers. */
  resolveWorker?(root: WorkflowRoot, selection: WorkerExecutionSelection): Promise<WorkerExecution>;
  /** Throws unless the root (and the worker, when given) may run in managed Git worktrees. Absent disables worktrees. */
  authorizeWorkspace?(root: WorkflowRoot, execution?: WorkerExecution): Promise<void>;
  wakeMain(scopeId: string): Promise<void>;
  showPlan?(state: WorkflowState, text: string): Promise<void>;
  /** Tells the workflow's chat what happened to it across a bridge restart. */
  notify?(state: WorkflowState, text: string): Promise<void>;
  /** Source hosts may supply their built CLI; packaged bundles share dist/cli.js. */
  cliPath?: string;
  log?: WorkflowLogger;
  processes?: WorkflowProcesses;
}

function resumeFailure(reason: string | undefined): string {
  if (reason === RESUME_ROOT_CHANGED) return '主会话、模型、工作区或权限已变化';
  if (reason === RESUME_DEADLINE) return '重启前已到截止时间';
  return `重放失败（${reason}）`;
}

export class WorkflowRuntime {
  readonly kernel: WorkflowKernel;
  private readonly ipc: WorkflowIpc;
  private workspaces?: WorkflowWorkspaces;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private ticking = false;
  private readonly scripts = new Map<string, { controller: AbortController; done: Promise<void>; depth: number }>();
  private readonly log: WorkflowLogger;

  constructor(private readonly deps: WorkflowRuntimeDeps) {
    this.log = deps.log ?? silentLogger;
    this.kernel = new WorkflowKernel(deps.path, {
      resolveRoot: deps.resolveRoot,
      getTimeoutMinutes: deps.getTimeoutMinutes,
      checkSelection: deps.checkSelection,
      nativeIdKind: deps.nativeIdKind,
      log: this.log,
      resolveWorker: (root, selection) => this.resolveWorker(root, selection),
      resolveWorkspace: async (root, workflowId, id) => {
        await this.workspacePolicy(root);
        await this.workspaceManager().binding(root, workflowId, id, new AbortController().signal);
      },
      workspace: async (state, input, signal) => {
        await this.workspacePolicy(state.root);
        signal.throwIfAborted();
        return this.workspaceManager().perform({ state, signal }, input);
      },
      execute: request => this.execute(request),
      wakeMain: deps.wakeMain,
    });
    this.ipc = new WorkflowIpc((caller, method, args) => this.kernel.call(caller, method, args),
      deps.cliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url)));
  }

  async start(): Promise<void> {
    await this.ipc.listen();
    for (const outcome of await this.kernel.resumeAfterRestart()) {
      const name = outcome.state.script?.name ?? outcome.state.workflowId;
      const text = outcome.resumed
        ? `Bridge 已重启，工作流「${name}」已自动续跑：已完成的调用直接复用，中断的调用重新执行，停机时间不计入截止时间。可用 /workflow status 查看进度。`
        : `Bridge 已重启，工作流「${name}」未能自动续跑：${resumeFailure(outcome.reason)}。处理后可用 /workflow resume 恢复，或 /workflow cancel 取消。`;
      this.log.info(outcome.resumed ? 'restart-resumed' : 'restart-resume-skipped', { workflowId: outcome.state.workflowId, reason: outcome.reason });
      await this.deps.notify?.(outcome.state, text)
        .catch(error => this.log.warn('restart-notice-failed', { error: String(error) }));
    }
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.log.warn('tick-failed', { error: String(error) }));
    }, 500);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      await this.kernel.tick();
      if (this.closed) return;
      for (const state of this.kernel.queuedScripts()) {
        const depth=state.parent?.depth ?? 0;
        // Separate bounded levels let children run while ancestor interpreters await their results.
        if ([...this.scripts.values()].filter(script=>script.depth===depth).length>=4) continue;
        if (this.scripts.has(state.workflowId)) continue;
        const controller = new AbortController();
        const done = Promise.resolve().then(() => this.runScript(state.root.scopeId, state.workflowId, controller));
        this.scripts.set(state.workflowId, { controller, done, depth });
        void done.finally(() => this.scripts.delete(state.workflowId))
          .catch(error => this.log.warn('script-failed', { error: String(error) }));
      }
    } finally { this.ticking = false; }
  }

  private async runScript(scopeId: string, workflowId: string, controller: AbortController): Promise<void> {
    if (this.closed) return;
    const begun = this.kernel.beginScript(scopeId, workflowId);
    if (!begun) return;
    const { runId } = begun.state.script!;
    const stop = this.kernel.onChange(scopeId, () => {
      const state = this.kernel.state(scopeId, workflowId);
      if (state?.status !== 'active' || state.script?.status !== 'running' || state.script.runId !== runId) controller.abort();
    });
    const deadline = setTimeout(() => controller.abort(new WorkflowStopped('deadline')),
      Math.max(0, begun.state.deadlineAt - Date.now()));
    deadline.unref();
    try {
      if (!begun.state.parent) await this.deps.showPlan?.(begun.state, this.kernel.plan(scopeId, workflowId));
      controller.signal.throwIfAborted();
      const text = await runScriptProgram({ source: begun.source, args: begun.state.script!.args, signal: controller.signal,
        agent: async input => {
          controller.signal.throwIfAborted();
          const call = await this.kernel.scriptAgent(scopeId, workflowId, runId, input);
          const result = await this.waitForScriptValue(scopeId, controller.signal, () => this.kernel.scriptTaskResult(scopeId, workflowId, runId, call.taskId));
          if (call.output === 'text') return result;
          try { return JSON.parse(result) as unknown; }
          catch { throw new Error('Agent output is not valid JSON'); }
        },
        mailbox: async input => {
          controller.signal.throwIfAborted();
          const call = await this.kernel.scriptMailbox(scopeId, workflowId, runId, input);
          return call.receiptId
            ? this.waitForScriptValue(scopeId, controller.signal, () => this.kernel.scriptMailboxResult(scopeId, workflowId, runId, call.receiptId!))
            : call.result;
        },
        work: async input => {
          controller.signal.throwIfAborted();
          const result = await this.kernel.scriptWork(scopeId, workflowId, runId, input);
          return (input as { kind?: string }).kind === 'consume'
            ? this.waitForScriptValue(scopeId, controller.signal, () => this.kernel.scriptConsumerResult(scopeId, workflowId, runId, (result as { consumerPool: string }).consumerPool))
            : result;
        },
        control: async input => {
          controller.signal.throwIfAborted();
          const call = await this.kernel.scriptControl(scopeId, workflowId, runId, input);
          if (call.kind === 'start') return { taskId: call.taskId, output: call.output };
          if (call.kind === 'join') {
            const result = await this.waitForScriptValue(scopeId, controller.signal, () => this.kernel.scriptTaskResult(scopeId, workflowId, runId, call.taskId!));
            if (call.output === 'text') return result;
            try { return JSON.parse(result) as unknown; }
            catch { throw new Error('Agent output is not valid JSON'); }
          }
          return this.waitForScriptValue(scopeId, controller.signal, () => this.kernel.scriptControlResult(scopeId, workflowId, runId, call));
        },
        workspace: input => this.kernel.scriptWorkspace(scopeId, workflowId, runId, input, controller.signal),
        progress: (kind, text) => this.kernel.scriptProgress(scopeId, workflowId, runId, kind, text),
      });
      this.kernel.finishScript(scopeId, workflowId, runId, { text });
    } catch (error) {
      if (!this.closed) this.kernel.finishScript(scopeId, workflowId, runId, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(deadline);
      stop();
      controller.abort(new WorkflowStopped('cleanup'));
    }
  }

  private waitForScriptValue<T>(scopeId: string, signal: AbortSignal, read: () => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { stop(); signal.removeEventListener('abort', check); };
      const check = () => {
        try {
          signal.throwIfAborted();
          const text = read();
          if (text !== undefined) { cleanup(); resolve(text); }
        } catch (error) { cleanup(); reject(error); }
      };
      const stop = this.kernel.onChange(scopeId, check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }

  bindMain(scopeId: string, mode: 'start' | 'continue', deadlineAt = Date.now() + 24 * 60 * 60_000) {
    const state = this.kernel.state(scopeId);
    if (mode === 'start' && state) throw new Error('Root already has a workflow; cancel or complete it first');
    if (mode === 'continue' && !state) throw new Error('No active workflow to continue');
    const binding = this.ipc.bind({ kind: 'main', scopeId, allowStart: mode === 'start',
      ...(state ? { workflowId: state.workflowId } : {}) }, deadlineAt);
    return { ...binding, instructions: `${WORKFLOW_TOOL_INSTRUCTIONS}\n\n${this.kernel.context(scopeId)}`,
      eventIds: state?.events.filter(event => !event.acknowledged).map(event => event.id) ?? [] };
  }

  private async execute(request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult> {
    const { workflow, task, session, attemptId, signal } = request;
    const pinned = session.execution ?? inheritedWorkerExecution(workflow.root, { agentKind: workflow.root.agentKind });
    const selection = { agentKind: pinned.agentKind, ...pinned.modelSettings };
    const current = await this.resolveWorker(workflow.root, selection);
    if (workflowDigest(current) !== workflowDigest(pinned)) throw new Error('Worker execution binding changed');
    if (task.workspaceId !== session.workspaceId) throw new Error('Worker workspace/session binding changed');
    const manager = task.workspaceId ? this.workspaceManager() : undefined;
    let workspace: WorkspaceBinding | undefined;
    if (task.workspaceId) {
      await this.workspacePolicy(workflow.root, pinned);
      workspace = await manager!.binding(workflow.root, workflow.workflowId, task.workspaceId, signal);
    }
    let lease: string | undefined;
    let run: WorkerRun | undefined;
    const binding = this.ipc.bind({ kind: 'worker', scopeId: workflow.root.scopeId, workflowId: workflow.workflowId,
      taskId: task.taskId, attemptId }, workflow.deadlineAt);
    try {
      if (workspace) {
        lease = manager!.begin(workspace, task.taskId);
        await manager!.verifySnapshot(workspace, signal);
      }
      run = await this.deps.runner.start({
        sessionKey: `workflow:${workflow.workflowId}:${session.sessionRef}`,
        root: workflow.root, execution: pinned, role: session.role, prompt: request.prompt, env: binding.env,
        validateBeforeRun: async () => {
          request.onAdmitted();
          const admitted = await this.resolveWorker(workflow.root, selection);
          if (workflowDigest(admitted) !== workflowDigest(pinned)) throw new Error('Worker binding changed while queued');
          if (workspace) {
            await this.workspacePolicy(workflow.root, pinned);
            await manager!.binding(workflow.root, workflow.workflowId, workspace.id, signal);
            await manager!.verifySnapshot(workspace, signal);
          }
        },
        ...(workspace ? { workspace: { id: workspace.id, path: workspace.path, rootDigest: workspace.rootDigest } } : {}),
        systemPrompt: workflowWorkerInstructions(task) + (workspace ? `\nManaged worktree: ${workspace.path}\nBaseline: ${workspace.baseCommit}\nWork only in this worktree; do not modify the original checkout or other worktrees. ${workspace.kind === 'review' ? 'Review the frozen HEAD; leave all tracked and untracked files unchanged.' : 'Commit intended changes before returning. Leave no untracked files or unfinished Git operations.'}` : ''),
        ...((task.agentId || task.workflowTool) && session.nativeSessionId ? { resume: { kind: session.nativeIdKind, id: session.nativeSessionId } } : {}),
        deadlineAt: workflow.deadlineAt, signal,
      });
      const active = run;
      let text: string | undefined;
      let question: string | undefined;
      let error: string | undefined;
      let normal = false;
      let yieldTimer: NodeJS.Timeout | undefined;
      const yieldIfWaiting = () => {
        if (!yieldTimer && this.kernel.waitingForChild(workflow.root.scopeId,workflow.workflowId,task.taskId,attemptId)) {
          yieldTimer=setTimeout(()=>{void active.stop('yield').catch(error=>this.log.warn('yield-failed',{error:String(error)}));},30_000);
          yieldTimer.unref();
        }
      };
      const stopWatching=this.kernel.onChange(workflow.root.scopeId,yieldIfWaiting);
      yieldIfWaiting();
      try {
        request.onRun(active.runId);
        for await (const event of active.events()) {
          if (event.type === 'session') request.onSession(event.nativeSessionId, event.model);
          else if (event.type === 'retry') { text = undefined; error = undefined; normal = false; }
          else if (event.type === 'final_text') text = event.text;
          else if (event.type === 'error') error = event.message;
          else if (event.type === 'done') normal = event.normal;
          else if (event.type === 'user_input') {
            question = event.question;
            await active.stop('input');
            break;
          }
        }
      } catch (cause) {
        await active.stop('cleanup');
        throw cause;
      } finally {
        stopWatching();if(yieldTimer) clearTimeout(yieldTimer);
      }
      const result = await active.result;
      if (workspace && result === 'completed') {
        if (!await active.waitForExit(5000)) throw new Error('Workspace worker has not exited');
        await manager!.verifySnapshot(workspace, signal);
      }
      return { status: result === 'completed' && normal ? 'completed' : result === 'stopped' ? 'stopped' : 'failed', text, question, error, stopReason: active.stopReason() };
    } finally {
      binding.release();
      if (workspace && lease) {
        // Native termination is authoritative; retain the lease if it is uncertain.
        if (!run || await run.waitForExit(5000)) manager!.end(workspace, lease);
        else throw new Error('Workspace worker termination is uncertain; worktree retained and blocked');
      }
    }
  }

  private workspaceManager(): WorkflowWorkspaces {
    if (this.closed) throw new Error('Workflow service is closed');
    if (!this.deps.workspaceRoot && this.deps.path === ':memory:') throw new Error('In-memory workflows require an explicit workspaceRoot');
    return this.workspaces ??= new WorkflowWorkspaces(this.deps.path === ':memory:' ? ':memory:' : this.deps.path + '.workspaces.sqlite',
      this.deps.workspaceRoot ?? join(dirname(this.deps.path), 'worktrees'), this.deps.processes);
  }

  private async workspacePolicy(root: WorkflowRoot, worker?: WorkerExecution): Promise<void> {
    if (!this.deps.authorizeWorkspace) throw new Error('Workspace execution is unavailable in this host');
    await this.checkRoot(root, 'Workspace root authorization changed');
    await this.deps.authorizeWorkspace(root, worker);
  }

  private async checkRoot(root: WorkflowRoot, message: string): Promise<void> {
    const current = await this.deps.resolveRoot(root.scopeId);
    if (!current || workflowDigest(current) !== workflowDigest(root)) throw new Error(message);
  }

  private async resolveWorker(root: WorkflowRoot, selection: WorkerExecutionSelection): Promise<WorkerExecution> {
    await this.checkRoot(root, 'Worker root authorization changed');
    const execution = this.deps.resolveWorker
      ? await this.deps.resolveWorker(root, selection)
      : inheritedWorkerExecution(root, selection);
    if (execution.agentKind !== selection.agentKind || execution.profile !== root.profile) throw new Error('Worker resolver changed authorized scope');
    return execution;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Fence calls before IPC/runner shutdown can turn an accepted child into a cancellation.
    this.kernel.beginShutdown();
    if (this.timer) clearInterval(this.timer);
    for (const run of this.scripts.values()) run.controller.abort(new WorkflowStopped('shutdown'));
    await Promise.allSettled([...this.scripts.values()].map(run => run.done));
    await this.ipc.close();
    await this.kernel.close();
    await this.workspaces?.close();
  }
}
