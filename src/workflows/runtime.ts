import type { RunPolicyAllow } from '../policy/run-policy';
import { fileURLToPath } from 'node:url';
import type { RunExecutor } from '../runtime/run-executor';
import { log } from '../core/logger';
import { WorkflowKernel } from './kernel';
import { WorkflowIpc, WORKFLOW_TOOL_INSTRUCTIONS } from './ipc';
import { workflowDigest } from './definitions';
import { inheritedWorkerExecution } from './execution';
import type { WorkerExecution, WorkerExecutionSelection, WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from './types';

export interface WorkflowRuntimeDeps {
  path: string;
  executor: RunExecutor;
  resolve(scopeId: string): Promise<{ root: WorkflowRoot; policy: RunPolicyAllow } | undefined>;
  resolveWorker?(root: WorkflowRoot, selection: WorkerExecutionSelection, policy: RunPolicyAllow):
    Promise<{ execution: WorkerExecution; policy: RunPolicyAllow }>;
  wakeMain(scopeId: string): Promise<void>;
  /** Source hosts may supply their built CLI; packaged bundles share dist/cli.js. */
  cliPath?: string;
}

export class WorkflowRuntime {
  readonly kernel: WorkflowKernel;
  private readonly ipc: WorkflowIpc;
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: WorkflowRuntimeDeps) {
    this.kernel = new WorkflowKernel(deps.path, {
      resolveRoot: async scope => (await deps.resolve(scope))?.root,
      resolveWorker: async (root, selection) => (await this.resolveWorker(root, selection)).execution,
      execute: request => this.execute(request),
      wakeMain: deps.wakeMain,
    });
    this.ipc = new WorkflowIpc((caller, method, args) => this.kernel.call(caller, method, args),
      deps.cliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url)));
  }

  async start(): Promise<void> {
    await this.ipc.listen();
    this.timer = setInterval(() => {
      void this.kernel.tick().catch(error => log.warn('workflow', 'tick-failed', { error: String(error) }));
    }, 500);
    this.timer.unref();
  }

  bindMain(scopeId: string, deadlineAt = Date.now() + 24 * 60 * 60_000) {
    const binding = this.ipc.bind({ kind: 'main', scopeId }, deadlineAt);
    const state = this.kernel.state(scopeId);
    return { ...binding, instructions: `${WORKFLOW_TOOL_INSTRUCTIONS}\n\n${this.kernel.context(scopeId)}`,
      eventIds: state?.events.filter(event => !event.acknowledged).map(event => event.id) ?? [] };
  }

  private async execute(request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult> {
    const { workflow, task, session, attemptId, signal } = request;
    const pinned = session.execution ?? inheritedWorkerExecution(workflow.root, { agentKind: workflow.root.agentKind });
    const selection = { agentKind: pinned.agentKind, ...pinned.modelSettings };
    const current = await this.resolveWorker(workflow.root, selection);
    if (workflowDigest(current.execution) !== workflowDigest(pinned)) throw new Error('Worker execution binding changed');
    const binding = this.ipc.bind({ kind: 'worker', scopeId: workflow.root.scopeId, workflowId: workflow.workflowId,
      taskId: task.taskId, attemptId }, workflow.deadlineAt);
    try {
      const execution = await this.deps.executor.submit({
        scopeId: `workflow:${workflow.workflowId}:${session.sessionRef}`,
        agentScopeId: workflow.root.scopeId,
        agentKind: pinned.agentKind, requireFinalAnswer: true,
        priority: 'background', env: binding.env,
        validateBeforeRun: async () => {
          const admitted = await this.resolveWorker(workflow.root, selection);
          if (workflowDigest(admitted.execution) !== workflowDigest(pinned)) throw new Error('Worker binding changed while queued');
        },
        policy: { ...current.policy, prompt: request.prompt },
        systemPrompt: '你是 bridge 管理的工作流子 agent。只完成给定文本分析任务。不要向用户或外部应用发送消息，不要修改代码、执行共享测试或派生子 agent。输出最终答复供主 agent 审查。角色提示不改变实际执行权限。',
        ...pinned.modelSettings,
        ...(session.nativeSessionId ? { [session.nativeIdKind]: session.nativeSessionId } : {}),
        deadlineAt: workflow.deadlineAt, signal,
        observability: { profile: pinned.profile, agent: pinned.agentKind, source: 'workflow', stage: session.role },
      });
      let text: string | undefined;
      let question: string | undefined;
      let error: string | undefined;
      let normal = false;
      try {
        request.onRun(execution.runId);
        for await (const event of execution.subscribe()) {
          if (event.type === 'system') {
            const id = event[session.nativeIdKind];
            if (id) request.onSession(id, event.model);
          } else if (event.type === 'retry') { text = undefined; error = undefined; normal = false; }
          else if (event.type === 'final_text') text = event.content;
          else if (event.type === 'error') error = event.message;
          else if (event.type === 'done') normal = event.terminationReason === 'normal';
          else if (event.type === 'user_input') {
            question = event.questions.map(item => item.title).join('\n');
            await execution.stop();
            break;
          }
        }
      } catch (cause) {
        await execution.stop();
        throw cause;
      }
      const result = await execution.result;
      return { status: result === 'completed' && normal ? 'completed' : result === 'stopped' ? 'stopped' : 'failed', text, question, error };
    } finally { binding.release(); }
  }

  private async resolveWorker(root: WorkflowRoot, selection: WorkerExecutionSelection) {
    const current = await this.deps.resolve(root.scopeId);
    if (!current || workflowDigest(current.root) !== workflowDigest(root)) throw new Error('Worker root authorization changed');
    const resolved = this.deps.resolveWorker
      ? await this.deps.resolveWorker(root, selection, current.policy)
      : { execution: inheritedWorkerExecution(root, selection), policy: current.policy };
    if (resolved.execution.agentKind !== selection.agentKind || resolved.execution.profile !== root.profile
      || resolved.policy.cwdRealpath !== root.cwdRealpath) throw new Error('Worker resolver changed authorized scope');
    return resolved;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.ipc.close();
    await this.kernel.close();
  }
}
