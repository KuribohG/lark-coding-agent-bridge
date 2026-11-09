import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { renderWorkflowPlan } from './presentation';
import { closeWorkQueue, enqueueWork, unfinishedWork, workStatus } from './work-queue';
import { bindConsumerPool, consumerResult, parseConsumerPool } from './consumer-pool';
import { consumerPools, memberPool, queueControl, queueName, queueNames } from './work-routing';
import { beginEventWait } from './event-waits';
import { mailboxOperation, receiveMessages, receiptMessages, relaySender, scheduleMemberTurn, sendMessage } from './durable-agents';
import { inheritedWorkerExecution } from './execution';
import { parseScriptAgentCall, scriptText, SCRIPT_MAX_TASKS } from './script-contract';
import { addArtifact, BUSY, findTask, pushEvent, readArtifact, requireState, sameRoot } from './kernel-state';
import type { KernelContext } from './kernel-context';
import type { WorkflowState } from './types';

/** The operations a running script reaches through the VM: agents, task handles, workspaces, work queues, mailboxes and its own result. */
export class ScriptApi {
  constructor(private readonly ctx: KernelContext) {}

  queuedScripts(): WorkflowState[] {
    return this.ctx.store.list().filter(state => state.status === 'active' && state.script?.status === 'queued' && this.ctx.children.executionAllowed(state))
      .sort((a,b)=>(b.parent?.depth ?? 0)-(a.parent?.depth ?? 0));
  }

  beginScript(scopeId: string, workflowId: string): { state: WorkflowState; source: string } | undefined {
    const state = this.ctx.store.state(scopeId, workflowId);
    if (!state || state.status !== 'active' || state.script?.status !== 'queued' || !this.ctx.children.executionAllowed(state)) return undefined;
    state.script.status = 'running';
    this.ctx.store.save(state);
    return { state, source: readArtifact(state, state.script.sourceRef).text };
  }

  async scriptAgent(scopeId: string, workflowId: string, runId: string, input: unknown, managed = false): Promise<{ taskId: string; output: 'text' | 'json' }> {
    const { ctx } = this;
    const { store, host } = ctx;
    if (ctx.closed) throw new Error('Workflow service is closed');
    const snapshot = requireState(store.state(scopeId, workflowId));
    if (!snapshot.script) throw new Error('Not a script workflow');
    const call = parseScriptAgentCall(input, snapshot.script.defaults, snapshot.root, host);
    if (call.workspace) {
      if (snapshot.parent || !host.resolveWorkspace) throw new Error('Workspace execution is unavailable in this workflow');
      await host.resolveWorkspace(snapshot.root, workflowId, call.workspace);
    }
    if (managed && call.member) throw new Error('startAgent creates independent task handles; use agent() for persistent members');
    const root = await host.resolveRoot(scopeId);
    if (!root || !sameRoot(root, snapshot.root)) throw new Error('Worker root authorization changed');
    const execution = await (host.resolveWorker?.(snapshot.root, call.selection) ?? inheritedWorkerExecution(snapshot.root, call.selection));
    const latestRoot = await host.resolveRoot(scopeId);
    if (!latestRoot || !sameRoot(root, latestRoot)) throw new Error('Worker root authorization changed');
    if (ctx.closed) throw new Error('Workflow service is closed');
    const state = requireState(store.state(scopeId, workflowId));
    const script = state.script!;
    if (state.status !== 'active' || script.runId !== runId || script.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Script run is inactive');
    if (state.workspaceKeys?.includes(call.key)) throw new Error('Script key already belongs to a workspace operation');
    if (call.workspace && state.tasks.some(task => task.workspaceId === call.workspace && (BUSY.has(task.status) || task.status === 'waiting_workflow'))) throw new Error('Workspace has an unfinished task; await it before scheduling another');
    if (state.waits?.some(wait => wait.key === call.key) || state.controlOperations?.some(operation => operation.key === call.key)) throw new Error('Script key already belongs to a control operation');
    if (memberPool(state, call.member)) throw new Error('Consumer pool members are reserved for consumeWork');
    if (consumerPools(state).some(pool => call.key === pool.key) || queueNames(state).some(name => call.key === queueControl(state, name)?.closeKey)) throw new Error('Script key already belongs to a work queue operation');
    if (script.calls.some(item => item.key === call.key) || script.mailboxCalls?.includes(call.key) || state.workQueue?.items.some(item => item.key === call.key)) throw new Error(`Duplicate agent key: ${call.key}`);
    if (script.calls.length >= script.maxCalls) throw new Error('Script agent call limit reached');
    const inputRefs = (call.inputs ?? []).map(key => {
      const source = script.calls.find(item => item.key === key);
      const task = source && state.tasks.find(item => item.taskId === source.taskId);
      if (!task || task.status !== 'result_ready' || !task.resultRefs.length) throw new Error(`agent input ${key} must be an awaited, successful agent call in this run`);
      return task.resultRefs.at(-1)!;
    });
    if (call.member) {
      const before=state.tasks.length;
      const scheduled = scheduleMemberTurn(state, call, execution, ctx.nativeIdKind(execution.agentKind), inputRefs);
      if (state.tasks.length>before && ctx.children.remainingTreeTasks(state)<=0) throw new Error('Workflow tree task budget reached');
      script.calls.push({ key: call.key, taskId: scheduled.task.taskId, cached: scheduled.cached });
      store.save(state);
      return { taskId: scheduled.task.taskId, output: call.output };
    }
    const cacheKey = workflowDigest({ key: call.key, prompt: call.prompt, output: call.output, execution,
      root: state.root, goal: state.goal, definition: state.definitionDigest, ...(call.workspace ? {workspace:call.workspace} : {}), ...(call.workflowTool ? {workflowTool:true} : {}), ...(managed ? { managed: true } : {}),
      ...(inputRefs.length ? { inputs: inputRefs.map(ref => readArtifact(state, ref).digest) } : {}) });
    const cached = state.tasks.find(task => task.cacheKey === cacheKey && (task.status === 'result_ready'
      || managed && (['failed', 'waiting_input'].includes(task.status) || task.scriptCancelled && ['cancelled', 'interrupted'].includes(task.status))));
    if (cached?.scriptCancelled && cached.status === 'interrupted') cached.status = 'cancelled';
    let task = cached ?? (call.workflowTool || managed ? state.tasks.find(task=>task.cacheKey===cacheKey) : undefined);
    if (task && !cached) {
      if (BUSY.has(task.status) || task.status==='waiting_workflow') throw new Error('Workflow-enabled agent still has an active turn');
      task.status='queued';task.error=undefined;task.scriptRunId=runId;
    }
    if (!task) {
      if (ctx.children.remainingTreeTasks(state)<=0) throw new Error('Workflow tree task budget reached');
      if (state.tasks.length >= SCRIPT_MAX_TASKS) throw new Error('Script task history limit reached');
      const sessionRef = randomUUID();
      const taskId = randomUUID();
      state.sessions.push({ sessionRef, actorId: randomUUID(), actorKey: taskId, role: 'worker', generation: 1,
        nativeIdKind: ctx.nativeIdKind(execution.agentKind), execution, ...(call.workspace ? {workspaceId:call.workspace} : {}) });
      task = { taskId, taskKey: taskId, requestDigest: cacheKey, sessionRef, objective: call.prompt, inputRefs,
        ...(call.workspace ? {workspaceId:call.workspace} : {}),
        ...(managed ? { scriptManaged: true } : {}),
        ...(call.workflowTool ? {workflowTool:true} : {}),
        status: 'queued', attempts: [], resultRefs: [], scriptRunId: runId, scriptKey: call.key, scriptOutput: call.output, ...(call.schema ? { scriptSchema: call.schema } : {}), cacheKey };
      state.tasks.push(task);
    }
    script.calls.push({ key: call.key, taskId: task.taskId, cached: Boolean(cached) });
    store.save(state);
    return { taskId: task.taskId, output: call.output };
  }

  async scriptWorkspace(scopeId: string, workflowId: string, runId: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const { ctx } = this;
    const { store, host } = ctx;
    if (ctx.closed) throw new Error('Workflow service is closed');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid workspace call');
    const args = input as Record<string, unknown>;
    const root = await host.resolveRoot(scopeId);
    const state = requireState(store.state(scopeId, workflowId));
    if (!root || !sameRoot(root, state.root)) throw new Error('Root binding changed');
    if (ctx.closed || state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Script run is inactive');
    if (state.parent || !host.workspace) throw new Error('Workspace operations are unavailable in this workflow');
    signal.throwIfAborted();
    const key = scriptText(args.key, 'workspace key', 100);
    if (key.trim() !== key || key.startsWith('@')) throw new Error('Invalid workspace key');
    if (state.script.workspaceCalls?.includes(key)) throw new Error('Duplicate workspace key');
    if ((state.script.workspaceCalls?.length ?? 0) >= 128) throw new Error('Workspace call limit reached');
    if (!state.workspaceKeys?.includes(key)) {
      this.checkWorkKey(state, key);
      if (state.workQueue?.items.some(item => item.key === key)) throw new Error('Script key already belongs to a work queue operation');
      if ((state.workspaceKeys?.length ?? 0) >= 256) throw new Error('Workspace key history limit reached');
      (state.workspaceKeys ??= []).push(key);
    }
    (state.script.workspaceCalls ??= []).push(key);
    store.save(state);
    const result = await host.workspace(state, args, signal);
    signal.throwIfAborted();
    const latest = requireState(store.state(scopeId, workflowId));
    if (ctx.closed || latest.status !== 'active' || latest.script?.runId !== runId || latest.script.status !== 'running') throw new Error('Script run is inactive');
    return result;
  }

  checkWorkKey(state: WorkflowState, value: unknown, operation: 'enqueue' | 'consume' | 'close' = 'enqueue'): string {
    const key = scriptText(value, 'work key', 160);
    if (state.workspaceKeys?.includes(key)) throw new Error('Script key already belongs to a workspace operation');
    if (key.startsWith('@wait/') || state.waits?.some(wait => wait.key === key) || state.controlOperations?.some(operation => operation.key === key)) throw new Error('Script key already belongs to a control operation');
    if (key.startsWith('@consumer/') || operation !== 'consume' && consumerPools(state).some(pool => key === pool.key)
      || operation !== 'close' && queueNames(state).some(name => key === queueControl(state, name)?.closeKey)
      || operation !== 'enqueue' && state.workQueue?.items.some(item => item.key === key)) throw new Error('Script key already belongs to another work queue operation');
    if (state.tasks.some(task => task.scriptKey === key) || state.mailbox?.receipts.some(receipt => receipt.key === key)
      || state.mailbox?.operations.some(operation => operation.key === 'script:' + key)) throw new Error('Script key already belongs to another operation: ' + key);
    return key;
  }

  async scriptControl(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<{ kind: string; taskId?: string; output?: 'text' | 'json'; waitId?: string }> {
    const { ctx } = this;
    const { store } = ctx;
    if (ctx.closed) throw new Error('Workflow service is closed');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid script control call');
    const { kind, ...args } = input as Record<string, unknown>;
    if (kind === 'start') return { kind, ...await this.scriptAgent(scopeId, workflowId, runId, args, true) };
    const root = await ctx.host.resolveRoot(scopeId);
    if (ctx.closed) throw new Error('Workflow service is closed');
    const state = requireState(store.state(scopeId, workflowId));
    if (!root || !sameRoot(root, state.root)) throw new Error('Root binding changed');
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Script run is inactive');
    if (!['join', 'cancel', 'wait'].includes(String(kind))) throw new Error('Unknown script control operation');
    if (kind === 'join' || kind === 'cancel') {
      const allowed = kind === 'join' ? ['taskId'] : ['key', 'taskId'];
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported task handle option');
      const task = findTask(state, scriptText(args.taskId, 'taskId', 100));
      if (!task.scriptManaged || !state.script.calls.some(call => call.taskId === task.taskId)) throw new Error('Task handle does not belong to this script run');
      if (kind === 'join') return { kind, taskId: task.taskId, output: task.scriptOutput ?? 'text' };
    }
    const key = scriptText(args.key, 'control key', 160);
    if (state.workspaceKeys?.includes(key)) throw new Error('Script key already belongs to a workspace operation');
    if (key.trim() !== key || key.startsWith('@')) throw new Error('Invalid control key');
    if (state.script.controlCalls?.includes(key)) throw new Error('Duplicate script control key');
    if ((state.script.controlCalls?.length ?? 0) >= 128) throw new Error('Script control call limit reached');
    if (state.tasks.some(task => task.scriptKey === key) || state.workQueue?.items.some(item => item.key === key)
      || consumerPools(state).some(pool => pool.key === key) || queueNames(state).some(name => queueControl(state, name)?.closeKey === key)
      || state.mailbox?.receipts.some(receipt => receipt.key === key) || state.mailbox?.operations.some(operation => operation.key === 'script:' + key)) throw new Error('Script key already belongs to another operation');
    if (kind === 'wait') {
      if (state.controlOperations?.some(operation => operation.key === key)) throw new Error('Control key changed operation kind');
      const wait = beginEventWait(state, args, ctx.now());
      (state.script.controlCalls ??= []).push(key);
      store.save(state);
      return { kind, waitId: wait.id };
    }
    if (state.waits?.some(wait => wait.key === key)) throw new Error('Control key changed operation kind');
    const task = findTask(state, String(args.taskId));
    const digest = workflowDigest({ taskId: task.taskId, requestDigest: task.requestDigest });
    const prior = state.controlOperations?.find(operation => operation.key === key);
    if (prior && prior.digest !== digest) throw new Error('Cancellation key conflict');
    if (!prior) {
      if ((state.controlOperations?.length ?? 0) >= 128) throw new Error('Control operation limit reached');
      if (BUSY.has(task.status) || task.status === 'waiting_workflow' || task.status === 'interrupted') {
        task.scriptCancelled = true;
        ctx.children.suspendChildren(state, true, task.taskId);
        ctx.scheduler.cancelTask(task, state);
      }
      (state.controlOperations ??= []).push({ key, digest, taskId: task.taskId });
    }
    (state.script.controlCalls ??= []).push(key);
    store.save(state);
    return { kind: 'cancel', taskId: task.taskId };
  }

  scriptControlResult(scopeId: string, workflowId: string, runId: string, call: { kind: string; taskId?: string; waitId?: string }): unknown | undefined {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running') throw new Error('Script run is inactive');
    if (call.kind === 'wait') {
      const wait = state.waits?.find(wait => wait.id === call.waitId && wait.runId === runId);
      if (!wait) throw new Error('Unknown script wait');
      return wait.status === 'ready' ? wait.result : undefined;
    }
    const task = findTask(state, String(call.taskId));
    if (BUSY.has(task.status) || task.status === 'waiting_workflow') return undefined;
    const branch = new Set<string>();
    for (const child of this.ctx.store.descendants(state).sort((a, b) => a.parent!.depth - b.parent!.depth)) {
      if (child.parent!.workflowId === workflowId ? child.parent!.taskId === task.taskId : branch.has(child.parent!.workflowId)) branch.add(child.workflowId);
      if (branch.has(child.workflowId) && child.tasks.some(task => BUSY.has(task.status) || task.status === 'waiting_workflow')) return undefined;
    }
    return { taskId: task.taskId, status: task.status };
  }

  async scriptWork(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<unknown> {
    const { ctx } = this;
    const { store, host } = ctx;
    if (ctx.closed) throw new Error('Workflow service is closed');
    const root = await host.resolveRoot(scopeId);
    if (ctx.closed) throw new Error('Workflow service is closed');
    let state = requireState(store.state(scopeId, workflowId));
    if (!root || !sameRoot(root, state.root)) throw new Error('Root binding changed');
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Script run is inactive');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid work queue call');
    const { kind, target, ...args } = input as Record<string, unknown>;
    const parent = target === 'parent' || args.queue === 'parent';
    if (target !== undefined && target !== 'parent' || parent && kind !== 'enqueue') throw new Error('Only enqueueWork supports queue: parent or target: parent');
    if (args.queue === 'parent') delete args.queue;
    const name = queueName(args.queue);
    if (kind === 'status') return workStatus(state, args);
    if (!['enqueue', 'consume', 'close'].includes(String(kind))) throw new Error('Unknown script work operation');
    const key = this.checkWorkKey(state, args.key, kind as 'enqueue' | 'consume' | 'close');
    if (state.script.workCalls?.includes(key)) throw new Error('Duplicate script key: ' + key);
    if ((state.script.workCalls?.length ?? 0) >= 128) throw new Error('Work queue script call limit reached');
    if (parent) {
      if (!state.parent?.parentQueue) throw new Error('Parent queue access was not granted for this child workflow');
      const parent=requireState(store.state(scopeId,state.parent.workflowId));
      if (parent.status!=='active' || parent.script?.status!=='running') throw new Error('Parent workflow is inactive');
      this.checkWorkKey(parent,key);
      const response=enqueueWork(parent,args,ctx.now());
      (state.script.workCalls ??= []).push(key);
      store.transaction(()=>{store.save(parent);store.save(state);});
      return response;
    }
    if (kind === 'consume') {
      const spec = parseConsumerPool(args, state, host);
      const executions = [];
      for (const member of spec.members) executions.push(await (host.resolveWorker?.(state.root, member.selection) ?? inheritedWorkerExecution(state.root, member.selection)));
      const currentRoot = await host.resolveRoot(scopeId);
      if (ctx.closed || !currentRoot || !sameRoot(root, currentRoot)) throw new Error('Consumer root authorization changed');
      state = requireState(store.state(scopeId, workflowId));
      if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Script run is inactive');
      this.checkWorkKey(state, key, 'consume');
      if ((state.script.workCalls?.length ?? 0) >= 128) throw new Error('Work queue script call limit reached');
      bindConsumerPool(state, spec, executions);
      (state.script.workCalls ??= []).push(key);
      store.save(state);
      return { consumerPool: key };
    }
    if (kind === 'close') {
      if (Object.keys(args).some(key => !['key', 'queue'].includes(key))) throw new Error('closeWorkQueue supports key and queue only');
      const control = queueControl(state, name);
      if (control?.closeKey && control.closeKey !== key) throw new Error('Queue closure key changed across replay');
      if (queueNames(state).some(other => other !== name && queueControl(state, other)?.closeKey === key)) throw new Error('Queue closure key belongs to another queue');
      const result = closeWorkQueue(state, ctx.now(), name);
      queueControl(state, name)!.closeKey = key;
      (state.script.workCalls ??= []).push(key);
      store.save(state);
      return result;
    }
    const response = enqueueWork(state, args, ctx.now());
    (state.script.workCalls ??= []).push(key);
    store.save(state);
    return response;
  }

  scriptConsumerResult(scopeId: string, workflowId: string, runId: string, key?: string): unknown | undefined {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    const pool = key === undefined ? state.consumerPool : consumerPools(state).find(pool => pool.key === key);
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running'
      || pool?.runId !== runId) throw new Error('Consumer pool run is inactive');
    return consumerResult(state, key);
  }

  async scriptMailbox(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<{ receiptId?: string; result?: unknown }> {
    const { ctx } = this;
    if (ctx.closed) throw new Error('Workflow service is closed');
    const root = await ctx.host.resolveRoot(scopeId);
    const state = requireState(ctx.store.state(scopeId, workflowId));
    if (!root || !sameRoot(root, state.root)) throw new Error('Root binding changed');
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Script run is inactive');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid mailbox call');
    const args = input as Record<string, unknown>;
    if (Object.keys(args).some(key => !['kind', 'member', 'text', 'key', 'topic', 'correlationId', 'relayFrom'].includes(key))) throw new Error('Unsupported mailbox option');
    if (args.kind !== 'send' && args.kind !== 'receive') throw new Error('Unknown mailbox operation');
    if (args.kind === 'receive' && (Object.hasOwn(args, 'text') || Object.hasOwn(args, 'relayFrom'))) throw new Error('receive() does not accept text or a sender');
    const key = scriptText(args.key, 'mailbox key', 160);
    if (state.workspaceKeys?.includes(key)) throw new Error('Script key already belongs to a workspace operation');
    if (key.startsWith('@wait/') || state.waits?.some(wait => wait.key === key) || state.controlOperations?.some(operation => operation.key === key)) throw new Error('Script key already belongs to a control operation');
    const target = scriptText(args.member, 'member name', 100);
    if (key.startsWith('@consumer/') || consumerPools(state).some(pool => key === pool.key) || queueNames(state).some(name => key === queueControl(state, name)?.closeKey)) throw new Error('Script key already belongs to a work queue operation');
    if (args.kind === 'receive' && memberPool(state, target)) throw new Error('Consumer pool members cannot wait on script receive()');
    if (key.trim() !== key) throw new Error('Mailbox key must not contain surrounding whitespace');
    if (state.script.calls.some(call => call.key === key) || state.script.mailboxCalls?.includes(key) || state.workQueue?.items.some(item => item.key === key)) throw new Error('Duplicate script key: ' + key);
    if ((state.script.mailboxCalls?.length ?? 0) >= 128) throw new Error('Mailbox call limit reached');
    if (args.kind === 'receive' ? state.mailbox?.operations.some(item => item.key === 'script:' + key)
      : state.mailbox?.receipts.some(item => item.key === key)) throw new Error('Mailbox key changed operation kind');
    const result = args.kind === 'send'
      ? { result: mailboxOperation(state, 'script:' + key, args, () => sendMessage(state, target, args.text, ctx.now(),
        args.relayFrom === undefined ? undefined : relaySender(state, scriptText(args.relayFrom, 'sender name', 100), args.text), args)) }
      : { receiptId: receiveMessages(state, target, key, args).id };
    (state.script.mailboxCalls ??= []).push(key);
    ctx.store.save(state);
    return result;
  }

  scriptMailboxResult(scopeId: string, workflowId: string, runId: string, receiptId: string): unknown[] | undefined {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running') throw new Error('Script run is inactive');
    return receiptMessages(state, receiptId);
  }

  scriptTaskResult(scopeId: string, workflowId: string, runId: string, taskId: string): string | undefined {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running') throw new Error('Script run is inactive');
    const task = findTask(state, taskId);
    if (task.status === 'result_ready') return readArtifact(state, task.resultRefs.at(-1)!).text;
    if (['failed', 'cancelled', 'interrupted', 'waiting_input'].includes(task.status)) throw new Error(task.error ?? `Agent ${task.scriptKey} is ${task.status}`);
    return undefined;
  }

  scriptProgress(scopeId: string, workflowId: string, runId: string, kind: 'phase' | 'log', text: string): void {
    const state = this.ctx.store.state(scopeId, workflowId);
    if (!state?.script || state.script.runId !== runId || state.script.status !== 'running') return;
    if (kind === 'phase') state.script.phase = text.slice(0, 200);
    else state.script.logs = [...state.script.logs, text.slice(0, 1000)].slice(-50);
    this.ctx.store.save(state);
  }

  finishScript(scopeId: string, workflowId: string, runId: string, result: { text: string } | { error: string }): void {
    const { ctx } = this;
    const state = ctx.store.state(scopeId, workflowId);
    if (!state?.script || state.script.runId !== runId || state.script.status !== 'running' || state.status !== 'active') return;
    if ('text' in result && consumerPools(state).some(pool => ['running', 'waiting'].includes(pool.status))) result = { error: 'Consumer pool is unfinished; await consumeWork and close the queue when production is finished' };
    if ('text' in result && unfinishedWork(state)) result = { error: 'Script returned with unfinished work items; continue consumption or explicitly cancel the workflow.' };
    if ('text' in result && state.tasks.some(task => task.scriptManaged && state.script!.calls.some(call => call.taskId === task.taskId)
      && (BUSY.has(task.status) || task.status === 'waiting_workflow'))) result = { error: 'Script returned with unfinished task handles; join or cancel every started task' };
    if ('text' in result && state.waits?.some(wait => wait.runId === runId && wait.status === 'waiting')) result = { error: 'Script returned with unfinished event waits' };
    if ('text' in result && ctx.store.descendants(state).some(child=>!['completed','cancelled'].includes(child.status))) result={error:'Script returned with unfinished child workflows'};
    if ('text' in result) {
      scriptText(result.text, 'script result');
      const artifact = addArtifact(state, 'workflow-result', result.text, ctx.now);
      state.script.resultRef = artifact.ref;
      state.script.status = 'result_ready';
      pushEvent(state, { kind: 'script_result_ready', artifactRef: artifact.ref, summary: 'Script result ready for main-agent review.' }, ctx.now);
    } else {
      state.script.status = 'failed';
      ctx.children.suspendChildren(state,true);
      state.script.error = result.error.slice(0, 2000);
      for (const pool of consumerPools(state)) if (['waiting', 'running'].includes(pool.status)) {
        pool.status = 'failed'; pool.reason = state.script.error;
      }
      for (const task of state.tasks) if (task.scriptRunId === runId && (BUSY.has(task.status) || task.status==='waiting_workflow')) ctx.scheduler.cancelTask(task, state);
      pushEvent(state, { kind: 'script_failed', summary: state.script.error }, ctx.now);
    }
    // Persist the result and the parent's continuation as one recovery boundary.
    if (state.parent) ctx.children.finishChild(state);
    else ctx.store.save(state);
  }

  plan(scopeId: string, workflowId?: string): string {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    if (!state.script) throw new Error('Workflow has no script plan');
    const plan = state.script.planRef
      ? readArtifact(state, state.script.planRef).text
      : `旧版实例没有保存文字方案。原始执行脚本：\n\n${readArtifact(state, state.script.sourceRef).text}`;
    return renderWorkflowPlan(state, plan);
  }
}
