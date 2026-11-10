import { dirname, join } from 'node:path';
import { WorkflowWorkspaces } from './workspaces';
import type { WorkspaceBinding } from './workspace-types';
import { fileURLToPath } from 'node:url';
import { silentLogger, stopReasonOf, WorkflowStopped, type WorkerRun, type WorkerRunner, type WorkerRunSpec, type WorkflowProcesses } from './ports';
import { checkJsonOutput } from './json-output';
import { RESUME_DEADLINE, RESUME_ROOT_CHANGED, WorkflowKernel } from './kernel';
import { WorkflowIpc } from './ipc';
import { WORKFLOW_TOOL_INSTRUCTIONS, workflowWorkerInstructions } from './tools/instructions';
import { workflowDigest } from './digest';
import { inheritedWorkerExecution } from './execution';
import { runScriptProgram, WorkflowAgentFailure } from './script-vm';
import { hostMatch } from './worker-hosts';
import type { WorkerExecution, WorkerExecutionPolicy, WorkerExecutionSelection, WorkflowLogger, WorkflowRoot, WorkflowState, WorkflowWorkerRequest, WorkflowWorkerResult } from './types';

const JSON_FORMAT_RETRIES = 2;
const jsonFormatRetryPrompt = (problem: string) => `上一条最终答复无法作为脚本结果：${problem.slice(0, 1500)}。不要重新执行任务或任何工具操作；只把上一条答复的内容按任务要求的 JSON 结构（如有 JSON Schema 须完全符合）重新输出，最终答复只包含这一个 JSON 值，不加代码块或其它文字。`;

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
  private admissionRequested = false;
  private tickAgain = false;
  private readonly scripts = new Map<string, { controller: AbortController; done: Promise<void>; depth: number }>();
  private readonly releasing = new Set<string>();
  private readonly log: WorkflowLogger;

  constructor(private readonly deps: WorkflowRuntimeDeps) {
    this.log = deps.log ?? silentLogger;
    this.kernel = new WorkflowKernel(deps.path, {
      resolveRoot: deps.resolveRoot,
      getTimeoutMinutes: deps.getTimeoutMinutes,
      checkSelection: deps.checkSelection,
      nativeIdKind: deps.nativeIdKind,
      repairJson: deps.repairJson,
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
      deps.cliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url)), deps.path === ':memory:' ? undefined : deps.path + '.endpoint.json');
  }

  async start(): Promise<void> {
    await this.ipc.listen();
    for (const outcome of await this.kernel.resumeAfterRestart()) {
      const name = outcome.state.script?.name ?? outcome.state.workflowId;
      const text = outcome.resumed
        ? `Bridge 已重启，工作流「${name}」已自动续跑：已完成的调用直接复用，${this.deps.runner.hosting ? '重启时仍在运行的调用接回原进程继续（原进程已不在时重新执行），' : ''}中断的调用重新执行，停机时间不计入截止时间。可用 /workflow status 查看进度。`
        : `Bridge 已重启，工作流「${name}」未能自动续跑：${resumeFailure(outcome.reason)}。处理后可用 /workflow resume 恢复，或 /workflow cancel 取消。`;
      this.log.info(outcome.resumed ? 'restart-resumed' : 'restart-resume-skipped', { workflowId: outcome.state.workflowId, reason: outcome.reason });
      await this.deps.notify?.(outcome.state, text)
        .catch(error => this.log.warn('restart-notice-failed', { error: String(error) }));
    }
    await this.releaseOrphanHosts();
    // A commit may have made work runnable: admit it at once, without asking the host anything. The interval runs
    // the full pass, which also covers what only the clock or the host changes: deadlines, leases, wait timers and
    // the root session's authorization.
    this.kernel.onCommit(() => this.requestAdmission());
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.log.warn('tick-failed', { error: String(error) }));
    }, 500);
    this.timer.unref();
    this.requestAdmission();
  }

  /** Coalesces the commits of one event-loop turn into a single admission pass. */
  private requestAdmission(): void {
    if (this.closed || this.admissionRequested) return;
    this.admissionRequested = true;
    setImmediate(() => {
      this.admissionRequested = false;
      if (this.closed) return;
      try {
        // A workflow whose root has not been checked recently waits for a full pass; run one now.
        if (this.kernel.admitReady()) void this.tick().catch(error => this.log.warn('tick-failed', { error: String(error) }));
        this.startScripts();
      } catch (error) { this.log.warn('admission-failed', { error: String(error) }); }
    });
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    if (this.ticking) { this.tickAgain = true; return; }
    this.ticking = true;
    try {
      await this.kernel.tick();
      if (this.closed) return;
      void this.releaseOrphanHosts();
      this.startScripts();
    } finally {
      this.ticking = false;
      // A pass was asked for while this one ran and may have been needed by something this one had already passed.
      if (this.tickAgain) { this.tickAgain = false; void this.tick().catch(error => this.log.warn('tick-failed', { error: String(error) })); }
    }
  }

  private startScripts(): void {
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
  }

  private async runScript(scopeId: string, workflowId: string, controller: AbortController): Promise<void> {
    if (this.closed) return;
    const begun = this.kernel.beginScript(scopeId, workflowId);
    if (!begun) return;
    const { runId } = begun.state.script!;
    const stop = this.kernel.watch(workflowId, ['lifecycle'], () => {
      if (!this.kernel.scriptRunning(scopeId, workflowId, runId)) controller.abort();
    });
    // Waiters wake on the events that can produce their value, not on every change in the scope.
    const watching = (...topics: string[]) => (listener: () => void) => this.kernel.watch(workflowId, [...topics, 'lifecycle'], listener);
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
          let result: string;
          // Only the worker's own failure is soft; invalid calls and stopped runs still reject.
          try { result = await this.waitForScriptValue(watching('task:' + call.taskId), controller.signal, () => this.kernel.scriptTaskResult(scopeId, workflowId, runId, call.taskId)); }
          catch (error) {
            if (controller.signal.aborted) throw error;
            throw new WorkflowAgentFailure(error instanceof Error ? error.message : String(error));
          }
          if (call.output === 'text') return result;
          try { return JSON.parse(result) as unknown; }
          catch { throw new WorkflowAgentFailure('Agent output is not valid JSON'); }
        },
        mailbox: async input => {
          controller.signal.throwIfAborted();
          const call = await this.kernel.scriptMailbox(scopeId, workflowId, runId, input);
          return call.receiptId
            ? this.waitForScriptValue(watching('mailbox'), controller.signal, () => this.kernel.scriptMailboxResult(scopeId, workflowId, runId, call.receiptId!))
            : call.result;
        },
        work: async input => {
          controller.signal.throwIfAborted();
          const result = await this.kernel.scriptWork(scopeId, workflowId, runId, input);
          return (input as { kind?: string }).kind === 'consume'
            ? this.waitForScriptValue(watching('pool'), controller.signal, () => this.kernel.scriptConsumerResult(scopeId, workflowId, runId, (result as { consumerPool: string }).consumerPool))
            : result;
        },
        control: async input => {
          controller.signal.throwIfAborted();
          const call = await this.kernel.scriptControl(scopeId, workflowId, runId, input);
          if (call.kind === 'start') return { taskId: call.taskId, output: call.output };
          if (call.kind === 'join') {
            const result = await this.waitForScriptValue(watching('task:' + call.taskId), controller.signal, () => this.kernel.scriptTaskResult(scopeId, workflowId, runId, call.taskId!));
            if (call.output === 'text') return result;
            try { return JSON.parse(result) as unknown; }
            catch { throw new Error('Agent output is not valid JSON'); }
          }
          // A cancellation is finished only when the task's child workflows have stopped too, so it follows the whole scope.
          return this.waitForScriptValue(call.kind === 'wait' ? watching('wait:' + call.waitId) : listener => this.kernel.onChange(scopeId, listener),
            controller.signal, () => this.kernel.scriptControlResult(scopeId, workflowId, runId, call));
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

  private waitForScriptValue<T>(subscribe: (listener: () => void) => () => void, signal: AbortSignal, read: () => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { stop(); signal.removeEventListener('abort', check); };
      const check = () => {
        try {
          signal.throwIfAborted();
          const text = read();
          if (text !== undefined) { cleanup(); resolve(text); }
        } catch (error) { cleanup(); reject(error); }
      };
      const stop = subscribe(check);
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
    // Worktree turns are verified against a frozen snapshot, which a process left running mid-change would not match.
    const hosting = task.workspaceId ? undefined : this.deps.runner.hosting;
    const match = hostMatch(task);
    let survivor = hosting && this.kernel.workerHost(workflow.workflowId, match);
    if (survivor && (survivor.discard || survivor.agentKind !== pinned.agentKind || !await hosting!.attachable(survivor.hostKey, pinned.agentKind))) {
      await this.releaseHost(survivor.hostKey);
      survivor = undefined;
    }
    if (signal.aborted) {
      if (survivor && stopReasonOf(signal) !== 'shutdown') await this.releaseHost(survivor.hostKey);
      signal.throwIfAborted();
    }
    const binding = this.ipc.bind({ kind: 'worker', scopeId: workflow.root.scopeId, workflowId: workflow.workflowId,
      taskId: task.taskId, attemptId }, workflow.deadlineAt, survivor?.tokenHash);
    let hostKey: string | undefined;
    try {
      if (workspace) {
        lease = manager!.begin(workspace, task.taskId);
        await manager!.verifySnapshot(workspace, signal);
      }
      const start = async (prompt: string, resume?: WorkerRunSpec['resume']) => {
        // A JSON restatement starts another process; the previous one has exited.
        if (hostKey) await this.releaseHost(hostKey);
        const attach = Boolean(survivor);
        hostKey = survivor?.hostKey ?? hosting?.newKey();
        survivor = undefined;
        if (hostKey) {
          this.kernel.putWorkerHost({ hostKey, workflowId: workflow.workflowId, match, taskId: task.taskId,
            agentKind: pinned.agentKind, tokenHash: binding.tokenHash, createdAt: Date.now() });
          if (attach) this.log.info('worker-reattach', { workflowId: workflow.workflowId, taskId: task.taskId, attemptId, hostKey });
        }
        return this.deps.runner.start({
          sessionKey: `workflow:${workflow.workflowId}:${session.sessionRef}`,
          root: workflow.root, execution: pinned, role: session.role, prompt, env: binding.env,
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
          ...(resume ? { resume } : {}),
          ...(hostKey ? { host: { key: hostKey, attach } } : {}),
          deadlineAt: workflow.deadlineAt, signal,
        });
      };
      const turn = async (active: WorkerRun) => {
        let text: string | undefined;
        let question: string | undefined;
        let error: string | undefined;
        let nativeSessionId: string | undefined;
        let normal = false;
        let yieldTimer: NodeJS.Timeout | undefined;
        const yieldIfWaiting = () => {
          if (!yieldTimer && this.kernel.waitingForChild(workflow.root.scopeId,workflow.workflowId,task.taskId,attemptId)) {
            yieldTimer=setTimeout(()=>{void active.stop('yield').catch(error=>this.log.warn('yield-failed',{error:String(error)}));},30_000);
            yieldTimer.unref();
          }
        };
        const stopWatching=this.kernel.watch(workflow.workflowId,['task:'+task.taskId],yieldIfWaiting);
        yieldIfWaiting();
        try {
          request.onRun(active.runId);
          for await (const event of active.events()) {
            if (event.type === 'session') { nativeSessionId = event.nativeSessionId; request.onSession(event.nativeSessionId, event.model); }
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
        return { result: await active.result, text, question, error, normal, nativeSessionId };
      };
      run = await start(request.prompt, (task.agentId || task.workflowTool) && session.nativeSessionId ? { kind: session.nativeIdKind, id: session.nativeSessionId } : undefined);
      let outcome = await turn(run);
      // A malformed or non-conforming JSON answer usually reflects formatting, not the work; ask the same session to restate it.
      for (let retry = 1; retry <= JSON_FORMAT_RETRIES; retry++) {
        if (task.scriptOutput !== 'json' || outcome.result !== 'completed' || !outcome.normal || outcome.question || !outcome.nativeSessionId || signal.aborted) break;
        const checked = checkJsonOutput(outcome.text ?? '', task.scriptSchema, this.deps.repairJson);
        if (!('problem' in checked)) break;
        if (!await run.waitForExit(5000)) throw new Error('Worker has not exited before the JSON format retry');
        this.log.warn('worker-json-format-retry', { workflowId: workflow.workflowId, taskId: task.taskId, attemptId, retry });
        run = await start(jsonFormatRetryPrompt(checked.problem), { kind: session.nativeIdKind, id: outcome.nativeSessionId });
        outcome = await turn(run);
      }
      const { result, text, question, error, normal } = outcome;
      const active = run;
      if (workspace && result === 'completed') {
        if (!await active.waitForExit(5000)) throw new Error('Workspace worker has not exited');
        await manager!.verifySnapshot(workspace, signal);
      }
      return { status: result === 'completed' && normal ? 'completed' : result === 'stopped' ? 'stopped' : 'failed', text, question, error, stopReason: active.stopReason() };
    } finally {
      binding.release();
      // A shutdown leaves the process running for the next controller's replay to reattach.
      const shutdown = signal.aborted && stopReasonOf(signal) === 'shutdown' || run?.stopReason() === 'shutdown';
      if (hostKey && !shutdown) await this.releaseHost(hostKey);
      if (workspace && lease) {
        // Native termination is authoritative; retain the lease if it is uncertain.
        if (!run || await run.waitForExit(5000)) manager!.end(workspace, lease);
        else throw new Error('Workspace worker termination is uncertain; worktree retained and blocked');
      }
    }
  }

  private async releaseHost(hostKey: string): Promise<void> {
    if (this.releasing.has(hostKey)) return;
    this.releasing.add(hostKey);
    try {
      await this.deps.runner.hosting?.release(hostKey);
    } catch (error) {
      this.log.warn('worker-host-release-failed', { hostKey, error: String(error) });
    } finally {
      this.releasing.delete(hostKey);
      this.kernel.removeWorkerHost(hostKey);
    }
  }

  /** Ends processes left by an earlier controller that no replayed turn can continue. */
  private async releaseOrphanHosts(): Promise<void> {
    if (!this.deps.runner.hosting) return;
    for (const record of this.kernel.orphanWorkerHosts()) {
      this.log.info('worker-host-orphaned', { workflowId: record.workflowId, taskId: record.taskId, hostKey: record.hostKey, discard: record.discard });
      await this.releaseHost(record.hostKey);
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
