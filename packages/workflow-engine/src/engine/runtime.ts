import { dirname, join } from 'node:path';
import { CLONE_REMOTE, WorkflowWorkspaces } from './workspaces';
import { scratchSlot, WorkflowScratch, type ScratchLease } from './scratch';
import type { WorkspaceBinding } from './workspace-types';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { silentLogger, stopReasonOf, WorkflowStopped, type WorkerRun, type WorkerRunner, type WorkerRunSpec, type WorkflowProcesses } from './ports';
import { checkJsonOutput } from './json-output';
import { RESUME_DEADLINE, RESUME_ROOT_CHANGED, WorkflowKernel } from './kernel';
import { WorkflowIpc } from './ipc';
import { hostToolInstructions, WORKFLOW_GUIDE, WORKFLOW_MESSAGE_INSTRUCTIONS, WORKFLOW_TOOL_INSTRUCTIONS, WORKFLOW_WAKE_INSTRUCTIONS, workflowWorkerInstructions } from './tools/instructions';
import { workflowDigest } from './digest';
import { sameRoot } from './kernel-state';
import { inheritedWorkerExecution } from './execution';
import { MAX_RUNNING_SCRIPTS } from './limits';
import { workflowToolDefinitions } from './host-tools';
import { runScriptProgram, WorkflowAgentFailure } from './script-vm';
import { hostMatch } from './worker-hosts';
import type { ExecutionLedgerPort, WorkerExecution, WorkerExecutionPolicy, WorkerExecutionSelection, WorkflowCaller, WorkflowLogger, WorkflowRoot, WorkflowState, WorkflowWorkerRequest, WorkflowWorkerResult } from './types';

const JSON_FORMAT_RETRIES = 2;
/** How often scratch directories nobody owns any more are looked for. */
const SCRATCH_RECLAIM_MS = 60_000;

/** What a worker is told about the managed checkout it runs in. */
function workspaceInstructions(workspace: WorkspaceBinding, landingRef: string | undefined): string {
  const clone = workspace.isolation === 'clone';
  const place = clone ? 'clone' : 'worktree';
  const branch = landingRef?.replace('refs/heads/', '');
  return `\nManaged ${place}: ${workspace.path}\nBaseline: ${workspace.baseCommit}\n`
    + (clone
      ? `This is a Git repository of your own: its branches, index, stash and locks are separate from the original checkout and from other members. The original checkout is the remote ${CLONE_REMOTE}; do not push to it. Work only in this clone. `
      : 'Work only in this worktree; do not modify the original checkout or other worktrees. ')
    + (workspace.kind === 'review' ? 'Review the frozen HEAD; leave all tracked and untracked files unchanged.' : 'Commit intended changes before returning. Leave no untracked files or unfinished Git operations.')
    + (branch ? `\nLanding branch: ${branch} (created by the first landing)${clone ? `, in the original checkout; \`git fetch ${CLONE_REMOTE}\` brings it here as ${CLONE_REMOTE}/${branch}` : ''}. submit_work rebases your commits onto it, has them checked together with other members' waiting work and lands them; a landing moves this ${place} to the branch head, with what others landed.` : '');
}
const jsonFormatRetryPrompt = (problem: string) => `上一条最终答复无法作为脚本结果：${problem.slice(0, 1500)}。不要重新执行任务或任何工具操作；只把上一条答复的内容按任务要求的 JSON 结构（如有 JSON Schema 须完全符合）重新输出，最终答复只包含这一个 JSON 值，不加代码块或其它文字。`;

export interface WorkflowRuntimeDeps extends WorkerExecutionPolicy {
  hostTools?: boolean;
  executionLedger?: ExecutionLedgerPort;
  /** SQLite path, or ':memory:' (managed worktrees then need an explicit workspaceRoot). */
  path: string;
  workspaceRoot?: string;
  /**
   * Where workers get a private temporary directory each (see WorkflowScratch): a directory on a local disk that
   * may be shared with other runtimes. Absent leaves workers on the machine's shared temporary directory.
   */
  scratchRoot?: string;
  runner: WorkerRunner;
  getTimeoutMinutes?(root: WorkflowRoot): number;
  /** Silence after which a running worker with no tool in flight is presumed hung; 0 disables the watchdog. */
  stallMs?: number;
  /** Backoff before each retry of a failed attempt, in order (last repeats). */
  retryDelaysMs?: readonly number[];
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


/**
 * The CLI that agents call for every workflow operation. A host that bundles the engine into its own CLI ships
 * `workflow-cli.js` beside it: the same command without the host's program, which is what a call spends its start on.
 */
function workerCliPath(): string {
  const slim = fileURLToPath(new URL('./workflow-cli.js', import.meta.url));
  return existsSync(slim) ? slim : fileURLToPath(new URL('./cli.js', import.meta.url));
}
export class WorkflowRuntime {
  readonly kernel: WorkflowKernel;
  private readonly ipc: WorkflowIpc;
  private workspaces?: WorkflowWorkspaces;
  private readonly scratch?: WorkflowScratch;
  private scratchReclaimedAt = 0;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private ticking = false;
  private admissionRequested = false;
  private tickAgain = false;
  private readonly scripts = new Map<string, { controller: AbortController; done: Promise<void>; depth: number }>();
  private readonly releasing = new Set<string>();
  /** The native run of each worker turn in progress, for messages from the main agent. */
  private readonly runs = new Map<string, WorkerRun>();
  private readonly log: WorkflowLogger;

  constructor(private readonly deps: WorkflowRuntimeDeps) {
    this.log = deps.log ?? silentLogger;
    if (deps.scratchRoot) this.scratch = new WorkflowScratch(deps.scratchRoot, deps.path, this.log);
    this.kernel = new WorkflowKernel(deps.path, {
      resolveRoot: deps.resolveRoot,
      executionLedger: deps.executionLedger,
      hostTools: deps.hostTools,
      getTimeoutMinutes: deps.getTimeoutMinutes,
      ...(deps.stallMs === undefined ? {} : { stallMs: deps.stallMs }),
      ...(deps.retryDelaysMs === undefined ? {} : { retryDelaysMs: deps.retryDelaysMs }),
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
      tell: async (_workflowId, taskId, text, messageId) => {
        const run = this.runs.get(taskId);
        return !run ? 'inactive' : run.send ? run.send(text, messageId) : 'unsupported';
      },
      land: async (state, input, signal) => {
        await this.workspacePolicy(state.root);
        signal.throwIfAborted();
        return this.workspaceManager().land({ state, signal }, input);
      },
      landing: async (state, input) => {
        await this.workspacePolicy(state.root);
        return this.workspaceManager().configure({ state, signal: new AbortController().signal }, input);
      },
      execute: request => this.execute(request),
      wakeMain: deps.wakeMain,
    });
    this.ipc = new WorkflowIpc((caller, method, args) => this.kernel.call(caller, method, args),
      deps.cliPath ?? workerCliPath(), deps.path === ':memory:' ? undefined : deps.path + '.endpoint.json');
  }

  async start(): Promise<void> {
    if (!this.deps.hostTools) await this.ipc.listen();
    await this.kernel.reconcileExecutions();
    for (const outcome of await this.kernel.resumeAfterRestart()) {
      const name = outcome.state.script?.name ?? outcome.state.workflowId;
      const text = outcome.resumed
        ? `Bridge 已重启，工作流「${name}」已自动续跑：已完成的调用直接复用，${this.deps.runner.hosting ? '重启时仍在运行的调用接回原进程继续（原进程已不在时重新执行），' : ''}中断的调用重新执行，成员持有的工作项认领保留给原成员，停机时间不计入截止时间。可用 /workflow status 查看进度。`
        : `Bridge 已重启，工作流「${name}」未能自动续跑：${resumeFailure(outcome.reason)}。处理后可用 /workflow resume 恢复，或 /workflow cancel 取消。`;
      this.log.info(outcome.resumed ? 'restart-resumed' : 'restart-resume-skipped', { workflowId: outcome.state.workflowId, reason: outcome.reason });
      await this.deps.notify?.(outcome.state, text)
        .catch(error => this.log.warn('restart-notice-failed', { error: String(error) }));
    }
    await this.releaseOrphanHosts();
    this.reclaimScratch();
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
      this.reclaimScratch();
      this.startScripts();
    } finally {
      this.ticking = false;
      // A pass was asked for while this one ran and may have been needed by something this one had already passed.
      if (this.tickAgain) { this.tickAgain = false; void this.tick().catch(error => this.log.warn('tick-failed', { error: String(error) })); }
    }
  }

  /** Deletes the scratch directories of finished workflows, retired members and finished one-shot workers. */
  private reclaimScratch(): void {
    if (!this.scratch || this.closed || Date.now() - this.scratchReclaimedAt < SCRATCH_RECLAIM_MS) return;
    this.scratchReclaimedAt = Date.now();
    void this.scratch.reclaim(this.kernel.scratchOwners()).catch(error => this.log.warn('scratch-reclaim-failed', { error: String(error) }));
  }

  private startScripts(): void {
    for (const state of this.kernel.queuedScripts()) {
      const depth=state.parent?.depth ?? 0;
      // Separate bounded levels let children run while ancestor interpreters await their results.
      if ([...this.scripts.values()].filter(script=>script.depth===depth).length>=MAX_RUNNING_SCRIPTS) continue;
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
    // The deadline may be extended while the script runs, so it is read again when the timer fires.
    let deadline: NodeJS.Timeout;
    const arm = (at: number) => {
      deadline = setTimeout(() => {
        const current = this.kernel.state(scopeId, workflowId)?.deadlineAt ?? 0;
        if (current > Date.now()) arm(current); else controller.abort(new WorkflowStopped('deadline'));
      }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
      deadline.unref();
    };
    arm(begun.state.deadlineAt);
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
          if ((input as { kind?: string }).kind === 'swarm') {
            return this.waitForScriptValue(watching('swarm'), controller.signal, () => this.kernel.scriptSwarmResult(scopeId, workflowId, runId, (result as { swarm: string }).swarm));
          }
          return result;
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
      if (!this.closed) this.kernel.finishScript(scopeId, workflowId, runId, { error: error instanceof Error ? error.message : String(error),
        ...(controller.signal.reason instanceof WorkflowStopped && controller.signal.reason.reason === 'deadline' ? { stopReason: 'deadline' as const } : {}) });
    } finally {
      clearTimeout(deadline!);
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
    const caller: WorkflowCaller = { kind: 'main', scopeId, allowStart: mode === 'start', ...(state ? { workflowId: state.workflowId } : {}) };
    const binding: { env: Record<string, string>; release(): void } = this.deps.hostTools ? { env: {}, release() {} } : this.ipc.bind(caller, deadlineAt);
    // The turn that starts a workflow writes its script; a wake only runs what exists, and is told no script API.
    const instructions = mode === 'start' ? WORKFLOW_TOOL_INSTRUCTIONS : WORKFLOW_WAKE_INSTRUCTIONS;
    return { ...binding, instructions: `${this.deps.hostTools ? hostToolInstructions(instructions) : instructions}\n\n${this.kernel.context(scopeId)}`,
      ...(this.deps.hostTools ? { definitions: workflowToolDefinitions('main'), call: (method: string, args: Record<string, unknown>) => this.call(caller, method, args) } : {}),
      eventIds: state?.events.filter(event => !event.acknowledged).map(event => event.id) ?? [] };
  }

  /**
   * Credentials for an ordinary user turn to inspect and steer the scope's workflow, or undefined when it has none.
   * The turn cannot start a workflow, and pending events stay with the wake that delivers them.
   */
  bindMessage(scopeId: string, deadlineAt = Date.now() + 24 * 60 * 60_000) {
    const state = this.kernel.state(scopeId);
    if (!state) return undefined;
    const caller: WorkflowCaller = { kind: 'main', scopeId, workflowId: state.workflowId };
    const binding = this.deps.hostTools ? { env: {}, release() {} } : this.ipc.bind(caller, deadlineAt);
    return { ...binding,
      ...(this.deps.hostTools ? { definitions: workflowToolDefinitions('main'), call: (method: string, args: Record<string, unknown>) => this.call(caller, method, args) } : {}),
      instructions: `${this.deps.hostTools ? hostToolInstructions(WORKFLOW_MESSAGE_INSTRUCTIONS) : WORKFLOW_MESSAGE_INSTRUCTIONS}\n<workflow_context source="bridge">\n${this.kernel.brief(scopeId)}\n</workflow_context>` };
  }

  /** Caller identity comes from an exact host turn, never from model args. */
  call(caller: WorkflowCaller, method: string, args: Record<string, unknown>) {
    if (method === 'guide' && this.deps.hostTools && caller.kind === 'main') return Promise.resolve(hostToolInstructions(WORKFLOW_GUIDE));
    return this.kernel.call(caller, method, args);
  }

  private async execute(request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult> {
    const { workflow, task, session, attemptId, executionId, logicalCallId, signal } = request;
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
    const landing = workspace?.kind === 'task' ? manager!.landing(workflow.workflowId) : undefined;
    let lease: string | undefined;
    let run: WorkerRun | undefined;
    // Worktree turns are verified against a frozen snapshot, which a process left running mid-change would not match.
    // Host tools answer through this process, so a worker that uses them cannot outlive it.
    const hosting = task.workspaceId || this.deps.hostTools ? undefined : this.deps.runner.hosting;
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
    const caller: WorkflowCaller = { kind: 'worker', scopeId: workflow.root.scopeId, workflowId: workflow.workflowId, taskId: task.taskId, attemptId };
    const binding: { env: Record<string, string>; tokenHash?: string; release(): void } = this.deps.hostTools
      ? { env: {}, release() {} } : this.ipc.bind(caller, workflow.deadlineAt, survivor?.tokenHash);
    let hostKey: string | undefined;
    let scratch: ScratchLease | undefined;
    // A one-shot worker that answered will not run again; its scratch directory goes with the turn.
    let finished = false;
    try {
      if (workspace) {
        lease = manager!.begin(workspace, task.taskId);
        await manager!.verifySnapshot(workspace, signal);
      }
      scratch = await this.scratch?.acquire(workflow.workflowId, scratchSlot(session.sessionRef, task.agentId ? session.actorKey : undefined));
      const scratchPath = scratch?.path;
      const start = async (prompt: string, resume?: WorkerRunSpec['resume']) => {
        // A JSON restatement starts another process; the previous one has exited.
        if (hostKey) await this.releaseHost(hostKey);
        const attach = Boolean(survivor);
        hostKey = survivor?.hostKey ?? hosting?.newKey();
        survivor = undefined;
        if (hostKey) {
          // Host-tool turns are never hosted, so a hosted turn always holds an IPC token.
          this.kernel.putWorkerHost({ hostKey, workflowId: workflow.workflowId, match, taskId: task.taskId,
            agentKind: pinned.agentKind, tokenHash: binding.tokenHash!, createdAt: Date.now() });
          if (attach) this.log.info('worker-reattach', { workflowId: workflow.workflowId, taskId: task.taskId, attemptId, hostKey });
        }
        const started = await this.deps.runner.start({
          executionId, logicalCallId, attemptId,
          ...(this.deps.hostTools ? { workflowTools: { definitions: workflowToolDefinitions('worker'),
            call: (method: string, args: Record<string, unknown>) => this.call(caller, method, args) } } : {}),
          sessionKey: `workflow:${workflow.workflowId}:${session.sessionRef}`,
          root: workflow.root, execution: pinned, role: session.role, prompt, env: scratch ? { ...binding.env, ...scratch.env } : binding.env,
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
          systemPrompt: (this.deps.hostTools ? hostToolInstructions(workflowWorkerInstructions(task)) : workflowWorkerInstructions(task))
            + (workspace ? workspaceInstructions(workspace, landing?.targetRef) : '')
            + (scratchPath ? `\nScratch directory: ${scratchPath} (your TMPDIR). It is yours alone and is deleted when your work in this workflow ends: keep temporary files, build outputs and caches there instead of /tmp or other shared locations, and put anything others must read somewhere else.` : ''),
          ...(resume ? { resume } : {}),
          ...(hostKey ? { host: { key: hostKey, attach } } : {}),
          deadlineAt: workflow.deadlineAt, signal,
        });
        this.runs.set(task.taskId, started);
        return started;
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
            else if (event.type === 'activity') this.kernel.noteWorkerActivity(task.taskId, attemptId, event.busy);
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
      // A session is bound once an attempt has run, so a later attempt of the same task continues that conversation
      // instead of redoing the work in a new one.
      run = await start(request.prompt, session.nativeSessionId ? { kind: session.nativeIdKind, id: session.nativeSessionId } : undefined);
      let outcome = await turn(run);
      // A malformed or non-conforming JSON answer usually reflects formatting, not the work; ask the same session to restate it.
      for (let retry = 1; retry <= JSON_FORMAT_RETRIES; retry++) {
        if (this.deps.executionLedger || task.scriptOutput !== 'json' || outcome.result !== 'completed' || !outcome.normal || outcome.question || !outcome.nativeSessionId || signal.aborted) break;
        // A turn that ended to wait for the child workflow it started has not answered yet: its answer follows the child's result.
        if (this.kernel.waitingForChild(workflow.root.scopeId, workflow.workflowId, task.taskId, attemptId)) break;
        const checked = checkJsonOutput(outcome.text ?? '', task.scriptSchema, this.deps.repairJson);
        if (!('problem' in checked)) break;
        if (!await run.waitForExit(5000)) throw new Error('Worker has not exited before the JSON format retry');
        this.log.warn('worker-json-format-retry', { workflowId: workflow.workflowId, taskId: task.taskId, attemptId, retry });
        run = await start(jsonFormatRetryPrompt(checked.problem), { kind: session.nativeIdKind, id: outcome.nativeSessionId });
        outcome = await turn(run);
      }
      const { result, text, question, error, normal } = outcome;
      const active = run;
      if (this.deps.executionLedger) {
        const receipt = await this.deps.executionLedger.lookupExecution(executionId, workflow.root.scopeId);
        if (receipt.state === 'not-submitted' && receipt.proof) return { status: signal.aborted || result === 'stopped' ? 'stopped' : 'failed',
          quiescence: 'quiescent', confirmedNotSubmitted: true, error: error || 'Host proved native input was not submitted' };
        const settlement = active.waitForQuiescence ? await active.waitForQuiescence(5000)
          : { state: await active.waitForExit(5000) ? 'quiescent' : 'unknown' };
        if (result === 'unknown' || settlement.state !== 'quiescent') return { status: 'unknown', quiescence: 'unknown', error: error || 'Native worker quiescence is unknown' };
        if (receipt.state !== 'completed') return { status: 'unknown', quiescence: 'unknown', error: 'Host completion receipt is not durable' };
        return receipt.result;
      }
      if (workspace && result === 'completed') {
        if (!await active.waitForExit(5000)) throw new Error('Workspace worker has not exited');
        await manager!.verifySnapshot(workspace, signal);
      }
      const status = result === 'completed' && normal ? 'completed' : result === 'stopped' ? 'stopped' : 'failed';
      finished = status === 'completed' && !question && !task.agentId && !task.workflowTool;
      return { status, text, question, error, stopReason: active.stopReason() };
    } finally {
      this.runs.delete(task.taskId);
      binding.release();
      // A shutdown leaves the process running for the next controller's replay to reattach.
      const shutdown = signal.aborted && stopReasonOf(signal) === 'shutdown' || run?.stopReason() === 'shutdown';
      if (hostKey && !shutdown) await this.releaseHost(hostKey);
      scratch?.release({ remove: finished, running: Boolean(hostKey && shutdown) });
      if (workspace && lease) {
        // Native termination is authoritative; retain the lease if it is uncertain.
        if (!run || (this.deps.executionLedger && run.waitForQuiescence ? (await run.waitForQuiescence(5000)).state === 'quiescent' : await run.waitForExit(5000))) manager!.end(workspace, lease);
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
    // The main session may change /model or /effort mid-run; the pinned root keeps the worker settings.
    if (!current || !sameRoot(current, root)) throw new Error(message);
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
    if (!this.deps.hostTools) await this.ipc.close();
    await this.kernel.close();
    await this.workspaces?.close();
  }
}
