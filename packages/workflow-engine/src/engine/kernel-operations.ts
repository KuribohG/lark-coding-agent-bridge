import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { closeWorkQueue, enqueueWork, mutateWork, retryWork, unfinishedWork, workContext, workStatus, WORK_MUTATIONS } from './work-queue';
import { consumerSummary } from './consumer-pool';
import { consumerPools, queueName } from './work-routing';
import { nestedContext } from './nested-workflow';
import { checkpoint, mailboxOperation, member, memberContext, saveCheckpoint, sendMessage, taskAgent } from './durable-agents';
import { workerSelection } from './execution';
import { boundedInteger, scriptArgs, scriptText, SCRIPT_DEFINITION, SCRIPT_MAX_TASKS } from './script-contract';
import {
  acknowledge, addArtifact, BUSY, findTask, optionalText, readArtifact, requiredText, requireState, sameRoot, textArray,
} from './kernel-state';
import type { KernelContext } from './kernel-context';
import type { WorkflowCaller, WorkflowState } from './types';

const MAIN_OPERATIONS = ['status', 'read_artifact', 'run_script', 'replay_script', 'publish_artifact', 'ack_events', 'cancel_task', 'pause', 'resume', 'cancel', 'complete', 'send_message', 'read_checkpoint', 'enqueue_work', 'retry_work', 'close_work_queue', 'work_status'];
const CONTROL_ARGS = ['workflowId', 'operationId', 'expectedStateVersion'];

type ScriptState = WorkflowState & { script: NonNullable<WorkflowState['script']> };
/** Applies one versioned main-agent operation to a loaded state; the caller commits it. Undefined responds with the status. */
type MainHandler = (ctx: KernelContext, state: ScriptState, args: Record<string, unknown>) => unknown;

const MAIN_HANDLERS: Record<string, MainHandler> = {
  close_work_queue: (ctx, state, args) => {
    if (Object.keys(args).some(key => ![...CONTROL_ARGS, 'queue'].includes(key))) throw new Error('Unsupported close_work_queue option');
    return closeWorkQueue(state, ctx.now(), queueName(args.queue));
  },
  enqueue_work: (ctx, state, args) => {
    ctx.scripts.checkWorkKey(state, args.key);
    return enqueueWork(state, operationInput(args), ctx.now());
  },
  retry_work: (ctx, state, args) => retryWork(state, operationInput(args), ctx.now()),
  send_message: (ctx, state, args) => sendMessage(state, requiredText(args.member, 100), args.text, ctx.now(), undefined, args),
  publish_artifact: (ctx, state, args) => {
    const kind = requiredText(args.kind, 100);
    if (!['context', 'report'].includes(kind)) throw new Error('Main artifacts support context and report');
    const artifact = addArtifact(state, kind, requiredText(args.text), ctx.now);
    return { ref: artifact.ref, kind: artifact.kind, digest: artifact.digest };
  },
  ack_events: (ctx, state, args) => {
    const ids = textArray(args.eventIds);
    if (ids.some(id => !state.events.some(event => event.id === id))) throw new Error('Unknown event ID');
    for (const event of state.events) if (ids.includes(event.id)) acknowledge(event, ctx.now());
    return { acknowledged: ids };
  },
  cancel_task: (ctx, state, args) => {
    const task = findTask(state, requiredText(args.taskId));
    ctx.children.suspendChildren(state,true,task.taskId);
    ctx.scheduler.cancelTask(task, state);
    return { taskId: task.taskId, status: task.status };
  },
  pause: (ctx, state) => {
    ctx.lifecycle.pause(state);
    return undefined;
  },
  complete: (ctx, state, args) => {
    if (!['result_ready', 'failed'].includes(state.script.status)) throw new Error('Script has not finished');
    if (state.tasks.some(task => BUSY.has(task.status))) throw new Error('Workers are still active');
    if (ctx.store.descendants(state).some(child => child.tasks.some(task => BUSY.has(task.status)))) throw new Error('Child workers are still active');
    if (ctx.store.descendants(state).some(child=>!['completed','cancelled'].includes(child.status))) throw new Error('Child workflows are unfinished');
    if (unfinishedWork(state)) throw new Error('Work items are unfinished; finish them or cancel the workflow');
    if (state.events.some(event => !event.acknowledged)) throw new Error('Acknowledge pending events before completion');
    const report = readArtifact(state, requiredText(args.reportRef));
    if (!['report', 'workflow-result'].includes(report.kind)) throw new Error('Completion requires a report or script result artifact');
    // A successful worker answer does not establish verification coverage.
    const response = { reportRef: report.ref, openIssues: textArray(args.openIssues), verificationLimits: requiredText(args.verificationLimits) };
    state.status = 'completed';
    return response;
  },
};

function operationInput(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_ARGS.includes(key)));
}

/** Tool-call entry point for the main agent and workers: authorization, idempotency and per-operation dispatch. */
export class KernelOperations {
  constructor(private readonly ctx: KernelContext) {}

  async call(caller: WorkflowCaller, method: string, args: Record<string, unknown>): Promise<unknown> {
    const { ctx } = this;
    const { store } = ctx;
    if (ctx.closed) throw new Error('Workflow service is closed');
    if (caller.kind === 'worker') {
      if (method === 'checkpoint' || method === 'send_message' || method === 'run_workflow' || WORK_MUTATIONS.includes(method)) {
        const root = await ctx.host.resolveRoot(caller.scopeId);
        if (ctx.closed) throw new Error('Workflow service is closed');
        const state = requireState(store.state(caller.scopeId, caller.workflowId));
        if (!root || !sameRoot(root, state.root)) throw new Error('Worker root binding changed');
      }
      return this.workerCall(caller, method, args);
    }
    if (!MAIN_OPERATIONS.includes(method)) {
      throw new Error(`Unsupported workflow operation: ${method}. Use run_script/replay_script.`);
    }
    if (method === 'run_script' && caller.allowStart !== true) {
      throw new Error('Workflow start requires an explicit /workflow start or /workflow script command');
    }
    if (caller.workflowId && args.workflowId && args.workflowId !== caller.workflowId) {
      throw new Error('Workflow ID is outside this run binding');
    }
    const scope = caller.scopeId;
    const workflowId = caller.workflowId ?? optionalText(args.workflowId);
    let state = store.state(scope, workflowId);
    if (method === 'status') return state ? this.summary(state) : { status: 'unbound' };
    if (method === 'read_artifact') {
      const bound = requireState(state);
      const ref = requiredText(args.ref);
      const owner = [bound, ...store.descendants(bound)].find(item => item.artifacts.some(artifact => artifact.ref === ref));
      return readArtifact(owner ?? bound, ref);
    }
    if (method === 'read_checkpoint') return checkpoint(requireState(state), member(requireState(state), requiredText(args.member, 100))) ?? null;
    if (method === 'work_status') return workStatus(requireState(state), { itemId: args.itemId, offset: args.offset, limit: args.limit });

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
    if (method === 'run_script') {
      if (state || store.state(scope)) throw new Error('Root already has a workflow; cancel or complete it first');
      const definition = structuredClone(SCRIPT_DEFINITION);
      definition.maxConcurrentWorkers = boundedInteger(args.maxConcurrent, 4, 1, 16);
      definition.maxWallTimeMinutes = ctx.host.getTimeoutMinutes?.(root) ?? definition.maxWallTimeMinutes;
      definition.defaultWallTimeMinutes = definition.maxWallTimeMinutes;
      const timeoutMs = definition.maxWallTimeMinutes * 60_000;
      const goal = requiredText(args.goal);
      const created: WorkflowState = {
        workflowId: randomUUID(), root, definition, definitionDigest: workflowDigest(definition), goal,
        stateVersion: 0, status: 'active', createdAt: ctx.now(),
        deadlineAt: ctx.now() + boundedInteger(args.timeoutMs, timeoutMs, 1000, timeoutMs),
        sessions: [], tasks: [], artifacts: [], events: [],
      };
      addArtifact(created, 'requirements', goal, ctx.now);
      const source = addArtifact(created, 'workflow-script', scriptText(args.script, 'script'), ctx.now);
      const plan = addArtifact(created, 'workflow-plan', scriptText(args.plan, 'plan', 12_000), ctx.now);
      created.script = { name: scriptText(args.name ?? 'Script workflow', 'name', 100), sourceRef: source.ref, planRef: plan.ref,
        args: scriptArgs(args.args), defaults: workerSelection(args.execution, root, ctx.host), runId: randomUUID(), revision: 0,
        status: 'queued', maxCalls: boundedInteger(args.maxAgents, 32, 1, SCRIPT_MAX_TASKS), calls: [], logs: [] };
      return store.commitOperation(created, operationId, digest, () => this.summary(created));
    }
    const bound = requireState(state);
    if (!bound.script) throw new Error('Agent-led workflows have been retired; use run_script.');
    const current = bound as ScriptState;
    if (method !== 'cancel' && !sameRoot(root, current.root)) {
      ctx.lifecycle.invalidate(scope);
      throw new Error('Root binding changed; workflow needs attention');
    }
    if (args.expectedStateVersion !== current.stateVersion) throw new Error(`stateVersion conflict; current=${current.stateVersion}`);
    if (['completed', 'cancelled'].includes(current.status)) throw new Error('Workflow is terminal');
    if (method === 'cancel') {
      ctx.lifecycle.cancelState(current);
      return store.commitOperation(current, operationId, digest, () => this.summary(current));
    }
    if (['replay_script', 'resume'].includes(method)) ctx.recovery.resumeClock(current);
    if (!['active', 'paused'].includes(current.status) && !(current.status === 'interrupted' && ['replay_script', 'resume', 'send_message', 'enqueue_work', 'retry_work', 'close_work_queue'].includes(method))) {
      throw new Error(`Workflow is ${current.status}; cancel and start a new workflow, or explicitly replay an interrupted script`);
    }
    if (ctx.now() >= current.deadlineAt && !['ack_events', 'publish_artifact', 'complete', 'cancel_task'].includes(method)) throw new Error('Workflow deadline reached');
    if (method === 'resume' || method === 'replay_script') {
      if (method === 'resume' && current.script.status !== 'paused' && current.status !== 'interrupted') throw new Error('Use replay_script to relaunch a completed or failed script');
      // Root and descendant replay must commit together.
      return store.transaction(() => {
        ctx.recovery.replayScript(current, args);
        return store.commitOperation(current, operationId, digest, () => ({ stateVersion: current.stateVersion, status: current.status }));
      });
    }
    const handler = Object.hasOwn(MAIN_HANDLERS, method) ? MAIN_HANDLERS[method] : undefined;
    if (!handler) throw new Error(`Unsupported workflow operation: ${method}`);
    const response = handler(ctx, current, args);
    return store.commitOperation(current, operationId, digest, () => ({ stateVersion: current.stateVersion, ...(response as object ?? { status: current.status }) }));
  }

  private workerCall(caller: Extract<WorkflowCaller, { kind: 'worker' }>, method: string, args: Record<string, unknown>): unknown {
    const { ctx } = this;
    const { store } = ctx;
    const state = requireState(store.state(caller.scopeId, caller.workflowId));
    if (WORK_MUTATIONS.includes(method)) ctx.scheduler.expireClaims(state);
    const task = findTask(state, caller.taskId);
    if (!['starting', 'running'].includes(task.status) || task.attempts.at(-1)?.attemptId !== caller.attemptId) throw new Error('Worker binding is inactive');
    const agent = taskAgent(state, task);
    if (agent && agent.activeTurnId !== task.taskId) throw new Error('Member turn is no longer active');
    if (method === 'task_status') return { taskId: task.taskId, status: task.status, checkpointVersion: agent?.checkpointVersion };
    if (method === 'read_context') return { goal: state.goal, objective: task.objective, inputRefs: task.inputRefs, member: memberContext(state, task), workQueue: workContext(state, task),
      ...(task.workflowTool ? {workflows:nestedContext(store.descendants(state,task.taskId),task)} : {}) };
    if (method === 'run_workflow') return ctx.children.runChildWorkflow(state,task,args);
    if (method === 'work_status') return workStatus(state, args);
    if (WORK_MUTATIONS.includes(method)) {
      if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
      const response = mutateWork(state, task, caller.attemptId, method, args, ctx.now());
      store.save(state);
      return response;
    }
    if (method === 'checkpoint' || method === 'send_message') {
      if (!agent) throw new Error('This operation requires a persistent member');
      if (state.status !== 'active' || state.script?.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
      const operationId = requiredText(args.operationId, 160);
      const response = mailboxOperation(state, 'worker:' + task.taskId + ':' + operationId, { method, args }, () => {
        if (method === 'send_message') return sendMessage(state, requiredText(args.member, 100), args.text, ctx.now(), agent.agentId, args);
        if (args.expectedCheckpointVersion !== agent.checkpointVersion) throw new Error('checkpointVersion conflict; read_context before updating');
        const saved = saveCheckpoint(state, task, args.state, ctx.now());
        return { checkpointRef: saved.ref, checkpointVersion: saved.version };
      });
      store.save(state);
      return response;
    }
    if (method === 'read_artifact') {
      const ref = requiredText(args.ref);
      if (!task.inputRefs.includes(ref)) throw new Error('Artifact is outside worker input scope');
      return readArtifact(state, ref);
    }
    throw new Error('Operation not permitted for worker');
  }

  summary(state: WorkflowState): unknown {
    return {
      workflowId: state.workflowId, plugin: { id: state.definition.id, version: state.definition.version, digest: state.definitionDigest },
      stateVersion: state.stateVersion, status: state.status, goalRef: state.artifacts[0]?.ref,
      goalPreview: state.goal.slice(0, 500),
      deadlineAt: state.deadlineAt, root: state.root,
      sessions: state.sessions,
      agents: state.agents ?? [],
      workQueue: state.workQueue ? workStatus(state) : undefined,
      consumerPools: consumerPools(state).map(pool => consumerSummary(state, pool.key)),
      consumers: consumerSummary(state),
      waits: (state.waits ?? []).map(wait => ({ key: wait.key, status: wait.status, createdAt: wait.createdAt,
        kinds: wait.any.map(arm => arm.kind), selected: wait.result?.index })),
      parent: state.parent ? {workflowId:state.parent.workflowId,taskId:state.parent.taskId,depth:state.parent.depth,key:state.parent.key} : undefined,
      children: this.ctx.store.descendants(state).map(child=>({workflowId:child.workflowId,parentWorkflowId:child.parent!.workflowId,
        key:child.parent!.key,depth:child.parent!.depth,status:child.status,scriptStatus:child.script?.status,
        sourceRef:child.script?.sourceRef,planRef:child.script?.planRef,resultRef:child.script?.resultRef})),
      checkpoints: (state.checkpoints ?? []).filter(item => state.agents?.some(agent => agent.checkpointRef === item.ref))
        .map(({ state: _state, ...item }) => item),
      mailbox: state.mailbox ? {
        totalMessages: state.mailbox.messages.length,
        unacknowledgedMessages: state.mailbox.messages.filter(item => !item.consumedByTurnId).length,
        recentMessages: state.mailbox.messages.slice(-8).map(({ text, ...item }) => ({ ...item, preview: text.slice(0, 160) })),
        waits: state.mailbox.receipts.filter(item => item.status === 'waiting').map(({ id, agentId }) => ({ id, agentId })),
      } : undefined,
      tasks: state.tasks.map(({ taskId, taskKey, sessionRef, status, resultRefs, error, attempts, scriptKey, agentId, previousTurnId, inputCheckpointVersion, inputMessageIds }) =>
        ({ taskId, taskKey, sessionRef, status, resultRefs, error, scriptKey, attempts, agentId, previousTurnId, inputCheckpointVersion, inputMessageIds })),
      artifacts: state.artifacts.map(({ text: _text, ...artifact }) => artifact),
      events: state.events.filter(event => !event.acknowledged),
      ...(state.script ? { script: { ...state.script, args: undefined, argsDigest: workflowDigest(state.script.args) } } : {}),
      executionAccess: 'same authorized profile; worker instructions are not a sandbox',
    };
  }
}
