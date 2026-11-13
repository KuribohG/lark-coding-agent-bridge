import { randomUUID } from 'node:crypto';
import { workflowDigest } from './digest';
import { renderWorkflowPlan } from './presentation';
import { closeWorkQueue, enqueueWork, unfinishedWork, workStatus } from './work-queue';
import { bindSwarm, memberSwarm, parseSwarm, swarmResult } from './swarm';
import { queueControl, queueName, queueNames } from './work-routing';
import { beginEventWait } from './event-waits';
import { postToBoard, readBoard } from './board';
import { mailboxOperation, receiveMessages, receiptMessages, relaySender, scheduleMemberTurn, sendMessage } from './durable-agents';
import { inheritedWorkerExecution } from './execution';
import { MAX_CONTROL_OPERATIONS, MAX_WORKSPACE_KEYS, SCRIPT_MAX_KEYED_CALLS } from './limits';
import { parseScriptAgentCall, scriptText } from './script-contract';
import { addArtifact, anyTask, archivedRecord, artifactOf, boardTotal, BUSY, callCount, controlOperationByKey, findTask, mailboxOperationByKey, pushEvent, readArtifact, receiptByKey, recordCall, requireState, sameRoot, scriptCall, scriptKeyRecorded, taskKeyUsed, waitByKey, workItemByKey, workspaceKeyUsed } from './kernel-state';
import { archiveOf, emit, putText } from './kernel-store';
import type { KernelContext } from './kernel-context';
import type { WorkerExecution, WorkflowState, WorkflowView, WorkflowWait } from './types';

/** The operations a running script reaches through the VM: agents, task handles, workspaces, work queues, mailboxes and its own result. */
export class ScriptApi {
  constructor(private readonly ctx: KernelContext) {}

  queuedScripts(): WorkflowView[] {
    return this.ctx.store.list().filter(state => state.status === 'active' && state.script?.status === 'queued' && this.ctx.children.executionAllowed(state))
      .sort((a,b)=>(b.parent?.depth ?? 0)-(a.parent?.depth ?? 0));
  }

  beginScript(scopeId: string, workflowId: string): { state: WorkflowState; source: string } | undefined {
    const { store } = this.ctx;
    const state = store.state(scopeId, workflowId);
    if (!state || state.status !== 'active' || state.script?.status !== 'queued' || !this.ctx.children.executionAllowed(state)) return undefined;
    store.transact(() => emit(state, { type: 'script_started' }), 'script:' + state.script.runId);
    return { state: store.public(state), source: readArtifact(state, state.script.sourceRef).text };
  }

  async scriptAgent(scopeId: string, workflowId: string, runId: string, input: unknown, managed = false): Promise<{ taskId: string; output: 'text' | 'json' }> {
    const { ctx } = this;
    const { store, host } = ctx;
    if (ctx.closed) throw new Error('Workflow service is closed');
    const snapshot = requireState(store.state(scopeId, workflowId));
    if (!snapshot.script) throw new Error('Not a script workflow');
    const pinned = snapshot.root;
    const call = parseScriptAgentCall(input, snapshot.script.defaults, pinned, host);
    if (call.workspace) {
      if (snapshot.parent || !host.resolveWorkspace) throw new Error('Workspace execution is unavailable in this workflow');
      await host.resolveWorkspace(pinned, workflowId, call.workspace);
    }
    if (managed && call.member) throw new Error('startAgent creates independent task handles; use agent() for persistent members');
    const root = await host.resolveRoot(scopeId);
    if (!root || !sameRoot(root, pinned)) throw new Error('Worker root authorization changed');
    const execution = await (host.resolveWorker?.(pinned, call.selection) ?? inheritedWorkerExecution(pinned, call.selection));
    const latestRoot = await host.resolveRoot(scopeId);
    if (!latestRoot || !sameRoot(root, latestRoot)) throw new Error('Worker root authorization changed');
    if (ctx.closed) throw new Error('Workflow service is closed');
    return store.transact(() => {
      const state = requireState(store.state(scopeId, workflowId));
      const script = state.script!;
      if (state.status !== 'active' || script.runId !== runId || script.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Script run is inactive');
      if (workspaceKeyUsed(state, call.key)) throw new Error('Script key already belongs to a workspace operation');
      if (call.workspace && state.tasks.some(task => task.workspaceId === call.workspace && (BUSY.has(task.status) || task.status === 'waiting_workflow'))) throw new Error('Workspace has an unfinished task; await it before scheduling another');
      if (waitByKey(state, call.key) || controlOperationByKey(state, call.key)) throw new Error('Script key already belongs to a control operation');
      if (memberSwarm(state, call.member)) throw new Error('Swarm members are scheduled by their swarm; steer them with board posts');
      if (state.swarms?.some(swarm => call.key === swarm.key) || queueNames(state).some(name => call.key === queueControl(state, name)?.closeKey)) throw new Error('Script key already belongs to a work queue operation');
      if (scriptCall(state, { key: call.key }) || scriptKeyRecorded(state, 'mailboxCalls', call.key) || workItemByKey(state, call.key)) throw new Error(`Duplicate agent key: ${call.key}`);
      if (callCount(state) >= script.maxCalls) throw new Error('Script agent call limit reached');
      const inputRefs = (call.inputs ?? []).map(key => {
        const source = scriptCall(state, { key });
        const task = source && anyTask(state, source.taskId);
        if (!task || task.status !== 'result_ready' || !task.resultRefs.length) throw new Error(`agent input ${key} must be an awaited, successful agent call in this run`);
        return task.resultRefs.at(-1)!;
      });
      if (call.member) {
        const before=state.tasks.length;
        const scheduled = scheduleMemberTurn(state, call, execution, ctx.nativeIdKind(execution.agentKind), inputRefs);
        if (state.tasks.length>before && ctx.children.remainingTreeTasks(state)<=0) throw new Error('Workflow tree task budget reached');
        recordCall(state, call.key, scheduled.task, scheduled.cached);
        return { taskId: scheduled.task.taskId, output: call.output };
      }
      const cacheKey = workflowDigest({ key: call.key, prompt: call.prompt, output: call.output, execution,
        root: state.root, goal: state.goal, definition: state.definitionDigest, ...(call.workspace ? {workspace:call.workspace} : {}), ...(call.workflowTool ? {workflowTool:true} : {}), ...(managed ? { managed: true } : {}),
        ...(inputRefs.length ? { inputs: inputRefs.map(ref => artifactOf(state, ref).digest) } : {}) });
      const cached = state.tasks.find(task => task.cacheKey === cacheKey && (task.status === 'result_ready'
        || managed && (['failed', 'waiting_input'].includes(task.status) || task.scriptCancelled && ['cancelled', 'interrupted'].includes(task.status))))
        ?? archiveOf(state)?.result(cacheKey);
      if (cached?.scriptCancelled && cached.status === 'interrupted') emit(state, { type: 'task_cancelled', taskId: cached.taskId });
      let task = cached ?? (call.workflowTool || managed ? state.tasks.find(task=>task.cacheKey===cacheKey) : undefined);
      if (task && !cached) {
        if (BUSY.has(task.status) || task.status==='waiting_workflow') throw new Error('Workflow-enabled agent still has an active turn');
        emit(state, { type: 'task_requeued', taskId: task.taskId, runId });
      }
      if (!task) {
        if (ctx.children.remainingTreeTasks(state)<=0) throw new Error('Workflow tree task budget reached');
        const sessionRef = randomUUID();
        const taskId = randomUUID();
        emit(state, { type: 'session_created', session: { sessionRef, actorId: randomUUID(), actorKey: taskId, role: 'worker', generation: 1,
          nativeIdKind: ctx.nativeIdKind(execution.agentKind), execution, ...(call.workspace ? {workspaceId:call.workspace} : {}) } });
        emit(state, { type: 'task_created', task: { taskId, taskKey: taskId, requestDigest: cacheKey, sessionRef, objective: putText(state, call.prompt), inputRefs,
          ...(call.workspace ? {workspaceId:call.workspace} : {}),
          ...(managed ? { scriptManaged: true } : {}),
          ...(call.workflowTool ? {workflowTool:true} : {}),
          status: 'queued', attempts: [], resultRefs: [], scriptRunId: runId, scriptKey: call.key, scriptOutput: call.output, ...(call.schema ? { scriptSchema: call.schema } : {}), cacheKey } });
        task = findTask(state, taskId);
      }
      recordCall(state, call.key, task, Boolean(cached));
      return { taskId: task.taskId, output: call.output };
    }, 'script:' + runId);
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
    if (scriptKeyRecorded(state, 'workspaceCalls', key)) throw new Error('Duplicate workspace key');
    if ((state.script.workspaceCalls?.length ?? 0) >= SCRIPT_MAX_KEYED_CALLS) throw new Error('Workspace call limit reached');
    store.transact(() => {
      if (!workspaceKeyUsed(state, key)) {
        this.checkWorkKey(state, key);
        if (workItemByKey(state, key)) throw new Error('Script key already belongs to a work queue operation');
        if ((state.workspaceKeys?.length ?? 0) >= MAX_WORKSPACE_KEYS) throw new Error('Workspace key history limit reached');
        emit(state, { type: 'workspace_key_reserved', key });
      }
      emit(state, { type: 'script_key_recorded', list: 'workspaceCalls', key });
    }, 'script:' + runId);
    const result = await host.workspace(store.public(state), args, signal);
    signal.throwIfAborted();
    const latest = requireState(store.state(scopeId, workflowId));
    if (ctx.closed || latest.status !== 'active' || latest.script?.runId !== runId || latest.script.status !== 'running') throw new Error('Script run is inactive');
    return result;
  }

  checkWorkKey(state: WorkflowView, value: unknown, operation: 'enqueue' | 'swarm' | 'close' = 'enqueue'): string {
    const key = scriptText(value, 'work key', 160);
    if (workspaceKeyUsed(state, key)) throw new Error('Script key already belongs to a workspace operation');
    if (key.startsWith('@wait/') || waitByKey(state, key) || controlOperationByKey(state, key)) throw new Error('Script key already belongs to a control operation');
    if (key.startsWith('@swarm/') || operation !== 'swarm' && state.swarms?.some(swarm => key === swarm.key)
      || operation !== 'close' && queueNames(state).some(name => key === queueControl(state, name)?.closeKey)
      || operation !== 'enqueue' && workItemByKey(state, key)) throw new Error('Script key already belongs to another work queue operation');
    if (taskKeyUsed(state, key) || receiptByKey(state, key)
      || mailboxOperationByKey(state, 'script:' + key)) throw new Error('Script key already belongs to another operation: ' + key);
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
    return store.transact(() => {
      const state = requireState(store.state(scopeId, workflowId));
      if (!root || !sameRoot(root, state.root)) throw new Error('Root binding changed');
      if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Script run is inactive');
      if (!['join', 'cancel', 'wait'].includes(String(kind))) throw new Error('Unknown script control operation');
      if (kind === 'join' || kind === 'cancel') {
        const allowed = kind === 'join' ? ['taskId'] : ['key', 'taskId'];
        if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported task handle option');
        const task = anyTask(state, scriptText(args.taskId, 'taskId', 100));
        if (!task) throw new Error('Task not found in workflow');
        if (!task.scriptManaged || !scriptCall(state, { taskId: task.taskId })) throw new Error('Task handle does not belong to this script run');
        if (kind === 'join') return { kind, taskId: task.taskId, output: task.scriptOutput ?? 'text' };
      }
      const key = scriptText(args.key, 'control key', 160);
      if (workspaceKeyUsed(state, key)) throw new Error('Script key already belongs to a workspace operation');
      if (key.trim() !== key || key.startsWith('@')) throw new Error('Invalid control key');
      if (scriptKeyRecorded(state, 'controlCalls', key)) throw new Error('Duplicate script control key');
      if ((state.script.controlCalls?.length ?? 0) >= SCRIPT_MAX_KEYED_CALLS) throw new Error('Script control call limit reached');
      if (taskKeyUsed(state, key) || workItemByKey(state, key)
        || state.swarms?.some(swarm => swarm.key === key) || queueNames(state).some(name => queueControl(state, name)?.closeKey === key)
        || receiptByKey(state, key) || mailboxOperationByKey(state, 'script:' + key)) throw new Error('Script key already belongs to another operation');
      if (kind === 'wait') {
        if (controlOperationByKey(state, key)) throw new Error('Control key changed operation kind');
        const wait = beginEventWait(state, args, ctx.now());
        emit(state, { type: 'script_key_recorded', list: 'controlCalls', key });
        return { kind, waitId: wait.id };
      }
      if (waitByKey(state, key)) throw new Error('Control key changed operation kind');
      // Checked above: the handle belongs to this run. An archived task has finished, which leaves nothing to cancel.
      const task = anyTask(state, String(args.taskId))!;
      const digest = workflowDigest({ taskId: task.taskId, requestDigest: task.requestDigest });
      const prior = controlOperationByKey(state, key);
      if (prior && prior.digest !== digest) throw new Error('Cancellation key conflict');
      if (!prior) {
        if ((state.controlOperations?.length ?? 0) >= MAX_CONTROL_OPERATIONS) throw new Error('Control operation limit reached');
        if (BUSY.has(task.status) || task.status === 'waiting_workflow' || task.status === 'interrupted') {
          emit(state, { type: 'task_script_cancelled', taskId: task.taskId });
          ctx.children.suspendChildren(state, true, task.taskId);
          ctx.scheduler.cancelTask(task, state);
        }
        emit(state, { type: 'control_operation_recorded', operation: { key, digest, taskId: task.taskId } });
      }
      emit(state, { type: 'script_key_recorded', list: 'controlCalls', key });
      return { kind: 'cancel', taskId: task.taskId };
    }, 'script:' + runId);
  }

  scriptControlResult(scopeId: string, workflowId: string, runId: string, call: { kind: string; taskId?: string; waitId?: string }): unknown | undefined {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running') throw new Error('Script run is inactive');
    if (call.kind === 'wait') {
      // An archived wait is settled and belongs to no run in particular: a replayed script reads its result again.
      const wait = state.waits?.find(wait => wait.id === call.waitId && wait.runId === runId)
        ?? (call.waitId === undefined ? undefined : archivedRecord<WorkflowWait>(state, 'wait', { id: call.waitId }));
      if (!wait) throw new Error('Unknown script wait');
      return wait.status === 'ready' ? wait.result : undefined;
    }
    const task = anyTask(state, String(call.taskId));
    if (!task) throw new Error('Task not found in workflow');
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
    const active = (state: WorkflowView) => state.status === 'active' && state.script?.runId === runId && state.script.status === 'running' && ctx.now() < state.deadlineAt;
    const snapshot = requireState(store.state(scopeId, workflowId));
    if (!root || !sameRoot(root, snapshot.root)) throw new Error('Root binding changed');
    if (!active(snapshot)) throw new Error('Script run is inactive');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid work queue call');
    const { kind, target, ...args } = input as Record<string, unknown>;
    const parent = target === 'parent' || args.queue === 'parent';
    if (target !== undefined && target !== 'parent' || parent && kind !== 'enqueue') throw new Error('Only enqueueWork supports queue: parent or target: parent');
    if (args.queue === 'parent') delete args.queue;
    const name = queueName(args.queue);
    if (kind === 'status') return workStatus(snapshot, args);
    if (!['enqueue', 'close', 'swarm'].includes(String(kind))) throw new Error('Unknown script work operation');
    const check = (state: WorkflowView) => {
      const key = this.checkWorkKey(state, args.key, kind as 'enqueue' | 'swarm' | 'close');
      if (scriptKeyRecorded(state, 'workCalls', key)) throw new Error('Duplicate script key: ' + key);
      if ((state.script!.workCalls?.length ?? 0) >= SCRIPT_MAX_KEYED_CALLS) throw new Error('Work queue script call limit reached');
      return key;
    };
    const record = (state: WorkflowView, key: string) => emit(state, { type: 'script_key_recorded', list: 'workCalls', key });
    if (kind === 'swarm') {
      check(snapshot);
      const spec = parseSwarm(args, snapshot, host);
      const pinned = snapshot.root;
      const executions: WorkerExecution[] = [];
      for (const member of spec.members) {
        if (member.workspace) {
          if (snapshot.parent || !host.resolveWorkspace) throw new Error('Workspace execution is unavailable in this workflow');
          await host.resolveWorkspace(pinned, workflowId, member.workspace);
        }
        executions.push(await (host.resolveWorker?.(pinned, member.selection) ?? inheritedWorkerExecution(pinned, member.selection)));
      }
      const currentRoot = await host.resolveRoot(scopeId);
      if (ctx.closed || !currentRoot || !sameRoot(root, currentRoot)) throw new Error('Swarm root authorization changed');
      return store.transact(() => {
        const state = requireState(store.state(scopeId, workflowId));
        if (!active(state)) throw new Error('Script run is inactive');
        const key = check(state);
        bindSwarm(state, spec, executions, ctx.now());
        record(state, key);
        return { swarm: key };
      }, 'script:' + runId);
    }
    return store.transact(() => {
      const state = requireState(store.state(scopeId, workflowId));
      const key = check(state);
      if (parent) {
        if (!state.parent?.parentQueue) throw new Error('Parent queue access was not granted for this child workflow');
        const owner=requireState(store.state(scopeId,state.parent.workflowId));
        if (owner.status!=='active' || owner.script?.status!=='running') throw new Error('Parent workflow is inactive');
        this.checkWorkKey(owner,key);
        const response=enqueueWork(owner,args,ctx.now());
        record(state, key);
        return response;
      }
      if (kind === 'close') {
        if (Object.keys(args).some(key => !['key', 'queue'].includes(key))) throw new Error('closeWorkQueue supports key and queue only');
        const control = queueControl(state, name);
        if (control?.closeKey && control.closeKey !== key) throw new Error('Queue closure key changed across replay');
        if (queueNames(state).some(other => other !== name && queueControl(state, other)?.closeKey === key)) throw new Error('Queue closure key belongs to another queue');
        const result = closeWorkQueue(state, ctx.now(), name, key);
        record(state, key);
        return result;
      }
      const response = enqueueWork(state, args, ctx.now());
      record(state, key);
      return response;
    }, 'script:' + runId);
  }

  scriptSwarmResult(scopeId: string, workflowId: string, runId: string, key: string): unknown | undefined {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running'
      || state.swarms?.find(swarm => swarm.key === key)?.runId !== runId) throw new Error('Swarm run is inactive');
    return swarmResult(state, key);
  }

  async scriptMailbox(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<{ receiptId?: string; result?: unknown }> {
    const { ctx } = this;
    if (ctx.closed) throw new Error('Workflow service is closed');
    const root = await ctx.host.resolveRoot(scopeId);
    return ctx.store.transact(() => {
      const state = requireState(ctx.store.state(scopeId, workflowId));
      if (!root || !sameRoot(root, state.root)) throw new Error('Root binding changed');
      if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || ctx.now() >= state.deadlineAt) throw new Error('Script run is inactive');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid mailbox call');
      const args = input as Record<string, unknown>;
      const board = args.kind === 'post' || args.kind === 'board';
      const allowed = args.kind === 'post' ? ['kind', 'key', 'text', 'to'] : args.kind === 'board' ? ['kind', 'key', 'after', 'limit', 'member']
        : ['kind', 'member', 'text', 'key', 'topic', 'correlationId', 'relayFrom'];
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported mailbox option');
      if (args.kind !== 'send' && args.kind !== 'receive' && !board) throw new Error('Unknown mailbox operation');
      if (args.kind === 'receive' && (Object.hasOwn(args, 'text') || Object.hasOwn(args, 'relayFrom'))) throw new Error('receive() does not accept text or a sender');
      const key = scriptText(args.key, 'mailbox key', 160);
      if (workspaceKeyUsed(state, key)) throw new Error('Script key already belongs to a workspace operation');
      if (key.startsWith('@wait/') || waitByKey(state, key) || controlOperationByKey(state, key)) throw new Error('Script key already belongs to a control operation');
      const target = board ? '' : scriptText(args.member, 'member name', 100);
      if (key.startsWith('@swarm/') || state.swarms?.some(swarm => key === swarm.key) || queueNames(state).some(name => key === queueControl(state, name)?.closeKey)) throw new Error('Script key already belongs to a work queue operation');
      if (args.kind === 'receive' && memberSwarm(state, target)) throw new Error('Swarm members are woken by the kernel and cannot wait on script receive()');
      if (key.trim() !== key) throw new Error('Mailbox key must not contain surrounding whitespace');
      if (scriptCall(state, { key }) || scriptKeyRecorded(state, 'mailboxCalls', key) || workItemByKey(state, key)) throw new Error('Duplicate script key: ' + key);
      if ((state.script.mailboxCalls?.length ?? 0) >= SCRIPT_MAX_KEYED_CALLS) throw new Error('Mailbox call limit reached');
      if (args.kind === 'receive' ? mailboxOperationByKey(state, 'script:' + key)
        : receiptByKey(state, key)) throw new Error('Mailbox key changed operation kind');
      // A board read records how far the feed reached, so a replayed script reads the same posts.
      const result = args.kind === 'post' ? { result: mailboxOperation(state, 'script:' + key, args, () => postToBoard(state, { author: 'script' }, args, ctx.now())) }
        : args.kind === 'board' ? { result: readBoard(state, { ...args, upTo: (mailboxOperation(state, 'script:' + key, args, () => ({ lastSeq: boardTotal(state) })) as { lastSeq: number }).lastSeq }) }
        : args.kind === 'send'
        ? { result: mailboxOperation(state, 'script:' + key, args, () => sendMessage(state, target, args.text, ctx.now(),
          args.relayFrom === undefined ? undefined : relaySender(state, scriptText(args.relayFrom, 'sender name', 100), args.text), args)) }
        : { receiptId: receiveMessages(state, target, key, args).id };
      emit(state, { type: 'script_key_recorded', list: 'mailboxCalls', key });
      return result;
    }, 'script:' + runId);
  }

  scriptMailboxResult(scopeId: string, workflowId: string, runId: string, receiptId: string): unknown[] | undefined {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running') throw new Error('Script run is inactive');
    return receiptMessages(state, receiptId);
  }

  scriptTaskResult(scopeId: string, workflowId: string, runId: string, taskId: string): string | undefined {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running') throw new Error('Script run is inactive');
    const task = anyTask(state, taskId);
    if (!task) throw new Error('Task not found in workflow');
    if (task.status === 'result_ready') return readArtifact(state, task.resultRefs.at(-1)!).text;
    if (['failed', 'cancelled', 'interrupted', 'waiting_input'].includes(task.status)) throw new Error(task.error ?? `Agent ${task.scriptKey} is ${task.status}`);
    return undefined;
  }

  scriptProgress(scopeId: string, workflowId: string, runId: string, kind: 'phase' | 'log', text: string): void {
    const state = this.ctx.store.state(scopeId, workflowId);
    if (!state?.script || state.script.runId !== runId || state.script.status !== 'running') return;
    this.ctx.store.transact(() => emit(state, kind === 'phase' ? { type: 'script_phase_set', phase: text.slice(0, 200) }
      : { type: 'script_logged', text: text.slice(0, 1000) }), 'script:' + runId);
  }

  finishScript(scopeId: string, workflowId: string, runId: string, result: { text: string } | { error: string }): void {
    const { ctx } = this;
    const state = ctx.store.state(scopeId, workflowId);
    if (!state?.script || state.script.runId !== runId || state.script.status !== 'running' || state.status !== 'active') return;
    ctx.store.transact(() => {
      if ('text' in result && state.swarms?.some(swarm => swarm.status === 'running' && swarm.runId === runId)) result = { error: 'Swarm is unfinished; await swarm()' };
      if ('text' in result && unfinishedWork(state)) result = { error: 'Script returned with unfinished work items; continue consumption or explicitly cancel the workflow.' };
      if ('text' in result && state.tasks.some(task => task.scriptManaged && state.script!.calls.some(call => call.taskId === task.taskId)
        && (BUSY.has(task.status) || task.status === 'waiting_workflow'))) result = { error: 'Script returned with unfinished task handles; join or cancel every started task' };
      if ('text' in result && state.waits?.some(wait => wait.runId === runId && wait.status === 'waiting')) result = { error: 'Script returned with unfinished event waits' };
      if ('text' in result && ctx.store.descendants(state).some(child=>!['completed','cancelled'].includes(child.status))) result={error:'Script returned with unfinished child workflows'};
      if ('text' in result) {
        scriptText(result.text, 'script result');
        const artifact = addArtifact(state, 'workflow-result', result.text, ctx.now);
        emit(state, { type: 'script_succeeded', resultRef: artifact.ref });
        pushEvent(state, { kind: 'script_result_ready', artifactRef: artifact.ref, summary: 'Script result ready for main-agent review.' }, ctx.now);
      } else {
        const error = result.error.slice(0, 2000);
        emit(state, { type: 'script_failed', error });
        ctx.children.suspendChildren(state,true);
        for (const task of state.tasks) if (task.scriptRunId === runId && (BUSY.has(task.status) || task.status==='waiting_workflow')) ctx.scheduler.cancelTask(task, state);
        pushEvent(state, { kind: 'script_failed', summary: error }, ctx.now);
      }
      // Persist the result and the parent's continuation as one recovery boundary.
      if (state.parent) ctx.children.finishChild(state);
    }, 'script:' + runId);
  }

  plan(scopeId: string, workflowId?: string): string {
    const state = requireState(this.ctx.store.state(scopeId, workflowId));
    if (!state.script) throw new Error('Workflow has no script plan');
    return renderWorkflowPlan(state, readArtifact(state, state.script.planRef ?? state.script.sourceRef).text);
  }
}
