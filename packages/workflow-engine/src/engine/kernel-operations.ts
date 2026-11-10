import { workflowDigest } from './digest';
import { optionalText, requiredText, requireState, sameRoot, findTask } from './kernel-state';
import { taskAgent } from './durable-agents';
import type { KernelContext } from './kernel-context';
import { workflowSummary } from './tools/lifecycle';
import { BUILTIN_WORKFLOW_TOOLS } from './tools/registry';
import type { ScriptState, WorkerCaller } from './tools/types';
import type { WorkflowCaller, WorkflowView } from './types';

/**
 * Tool-call entry point for the main agent and workers. It owns authorization, idempotency and the shared state
 * checks; the operations themselves are workflow tool plugins (see tools/registry.ts).
 */
export class KernelOperations {
  constructor(private readonly ctx: KernelContext, private readonly tools = BUILTIN_WORKFLOW_TOOLS) {}

  async call(caller: WorkflowCaller, method: string, args: Record<string, unknown>): Promise<unknown> {
    const { ctx } = this;
    const { store } = ctx;
    if (ctx.closed) throw new Error('Workflow service is closed');
    if (caller.kind === 'worker') {
      const tool = this.tools.worker(method);
      if (tool?.verifiesRoot) {
        const root = await ctx.host.resolveRoot(caller.scopeId);
        if (ctx.closed) throw new Error('Workflow service is closed');
        const state = requireState(store.state(caller.scopeId, caller.workflowId));
        if (!root || !sameRoot(root, state.root)) throw new Error('Worker root binding changed');
      }
      // What `prepare` settles (expired leases) stands even when the call itself is then refused.
      if (tool?.prepare) store.transact(() => tool.prepare!(ctx, requireState(store.state(caller.scopeId, caller.workflowId))), 'worker:' + caller.taskId);
      return store.transact(() => this.workerCall(caller, method, args), 'worker:' + caller.taskId);
    }
    const tool = this.tools.main(method);
    if (!tool) {
      throw new Error(`Unsupported workflow operation: ${method}. Use run_script/replay_script.`);
    }
    if (tool.kind === 'start' && caller.allowStart !== true) {
      throw new Error('Workflow start requires an explicit /workflow start or /workflow script command');
    }
    if (caller.workflowId && args.workflowId && args.workflowId !== caller.workflowId) {
      throw new Error('Workflow ID is outside this run binding');
    }
    const scope = caller.scopeId;
    const workflowId = caller.workflowId ?? optionalText(args.workflowId);
    let state = store.state(scope, workflowId);
    if (tool.kind === 'read') return tool.read(ctx, state, args);

    const operationId = requiredText(args.operationId, 200);
    const digest = workflowDigest({ method, args });
    const prior = store.operation(scope, operationId);
    if (prior) {
      if (prior.digest !== digest) throw new Error('operationId conflict: same ID with different content');
      return JSON.parse(prior.response);
    }
    const root = await ctx.host.resolveRoot(scope);
    if (!root) throw new Error('No authorized active root session');
    const committed = store.operation(scope, operationId);
    if (committed) {
      if (committed.digest !== digest) throw new Error('operationId conflict: same ID with different content');
      return JSON.parse(committed.response);
    }
    // The root may have changed while awaiting authorization.
    state = store.state(scope, workflowId);
    const cause = 'main:' + method;
    if (tool.kind === 'start') {
      return store.transact(() => {
        if (state || store.state(scope)) throw new Error('Root already has a workflow; cancel or complete it first');
        const created = tool.start(ctx, root, args);
        return store.commitOperation(scope, operationId, digest, () => this.summary(created));
      }, cause);
    }
    const bound = requireState(state);
    if (!bound.script) throw new Error('Not a script workflow');
    const current = bound as ScriptState;
    if (!tool.terminalCheckOnly && !sameRoot(root, current.root)) {
      ctx.lifecycle.invalidate(scope);
      throw new Error('Root binding changed; workflow needs attention');
    }
    // One transaction per operation: its events, the new state version and the idempotency record commit together.
    return store.transact(() => {
      if (args.expectedStateVersion !== current.stateVersion) throw new Error(`stateVersion conflict; current=${current.stateVersion}`);
      if (['completed', 'cancelled'].includes(current.status)) throw new Error('Workflow is terminal');
      const commit = (response: () => unknown) => store.commitOperation(scope, operationId, digest, response);
      if (tool.terminalCheckOnly) return tool.apply(ctx, current, args, commit);
      if (tool.resumesClock) ctx.recovery.resumeClock(current);
      if (!['active', 'paused'].includes(current.status) && !(current.status === 'interrupted' && tool.allowInterrupted)) {
        throw new Error(`Workflow is ${current.status}; cancel and start a new workflow, or explicitly replay an interrupted script`);
      }
      if (ctx.now() >= current.deadlineAt && !tool.allowAfterDeadline) throw new Error('Workflow deadline reached');
      return tool.apply(ctx, current, args, commit);
    }, cause);
  }

  private workerCall(caller: WorkerCaller, method: string, args: Record<string, unknown>): unknown {
    const { ctx } = this;
    const state = requireState(ctx.store.state(caller.scopeId, caller.workflowId));
    const tool = this.tools.worker(method);
    const task = findTask(state, caller.taskId);
    if (!['starting', 'running'].includes(task.status) || task.attempts.at(-1)?.attemptId !== caller.attemptId) throw new Error('Worker binding is inactive');
    const agent = taskAgent(state, task);
    if (agent && agent.activeTurnId !== task.taskId) throw new Error('Member turn is no longer active');
    if (!tool) throw new Error('Operation not permitted for worker');
    return tool.call(ctx, state, task, caller, args);
  }

  summary(state: WorkflowView): unknown {
    return workflowSummary(this.ctx, state);
  }
}
