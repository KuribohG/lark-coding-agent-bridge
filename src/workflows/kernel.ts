import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { sessionIdFieldForAgent } from '../agent/backend-spec';
import { log } from '../core/logger';
import { workflowDigest } from './digest';
import { renderWorkflowPlan } from './presentation';
import { cancelWork, closeWorkQueue, enqueueWork, expireWorkClaims, mutateWork, releaseWorkClaims, retryWork, unfinishedWork, workContext, workStatus, WORK_MUTATIONS } from './work-queue';
import { bindConsumerPool, consumerResult, consumerSummary, parseConsumerPool, pumpConsumerPool } from './consumer-pool';
import { checkpoint, completeMemberTurn, mailboxOperation, member, memberContext, receiveMessages, receiptMessages, saveCheckpoint, scheduleMemberTurn, sendMessage, taskAgent } from './durable-agents';
import { inheritedWorkerExecution, workerSelection } from './execution';
import { boundedInteger, parseScriptAgentCall, scriptArgs, scriptText, SCRIPT_DEFINITION, SCRIPT_MAX_REVISIONS, SCRIPT_MAX_TASKS } from './script-contract';
import type {
  WorkflowArtifact, WorkflowCaller, WorkflowEvent, WorkflowHost, WorkflowRoot,
  WorkflowState, WorkflowTask, WorkflowWorkerResult,
} from './types';

const BUSY = new Set<WorkflowTask['status']>(['queued', 'starting', 'running', 'cancelling']);
const MAX_TEXT = 100_000;

/** Bridge-owned state. No model or CLI process opens this database. */
export class WorkflowKernel {
  private readonly db: Database.Database;
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private pumping = false;
  private closed = false;
  private readonly waking = new Set<string>();
  private readonly changes = new EventEmitter().setMaxListeners(0);

  constructor(path: string, private readonly host: WorkflowHost, private readonly now = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS workflow_binding ON workflows(scope) WHERE status NOT IN ('completed', 'cancelled');
      CREATE TABLE IF NOT EXISTS workflow_operations (scope TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
        response TEXT NOT NULL, PRIMARY KEY(scope, id));
    `);
    // Retire old agent-led instances without discarding their evidence or blocking new scripts.
    for (const state of this.list()) {
      if (['completed', 'cancelled'].includes(state.status)) continue;
      state.status = state.script ? 'interrupted' : 'cancelled';
      if (state.script) state.script.status = 'interrupted';
      if (state.consumerPool) state.consumerPool.status = 'suspended';
      releaseWorkClaims(state, this.now(), 'Bridge restarted; explicitly replay to continue');
      for (const task of state.tasks) if (BUSY.has(task.status) || (!state.script && task.status === 'waiting_input')) {
        task.status = state.script ? 'interrupted' : 'cancelled';
        task.error = state.script ? 'Bridge restarted; explicitly replay the script to continue.' : 'Agent-led workflows have been retired.';
      }
      this.save(state);
    }
  }

  private list(): WorkflowState[] {
    return (this.db.prepare("SELECT data FROM workflows WHERE status NOT IN ('completed', 'cancelled')").all() as Array<{ data: string }>).map(row => JSON.parse(row.data));
  }

  state(scopeId: string, workflowId?: string): WorkflowState | undefined {
    const row = (workflowId
      ? this.db.prepare('SELECT data FROM workflows WHERE id = ? AND scope = ?').get(workflowId, scopeId)
      : this.db.prepare("SELECT data FROM workflows WHERE scope = ? AND status NOT IN ('completed', 'cancelled')").get(scopeId)
    ) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as WorkflowState : undefined;
  }

  context(scopeId: string): string {
    const state = this.state(scopeId);
    return state
      ? `${state.definition.mainInstructions}\n<workflow_context source="bridge">\n${JSON.stringify(this.summary(state))}\n</workflow_context>`
      : '当前没有绑定工作流；仅 /workflow start 或 /workflow script 命令授权的本轮可调用 run_script。';
  }

  latest(scopeId: string): WorkflowState | undefined {
    const row = this.db.prepare('SELECT data FROM workflows WHERE scope = ? ORDER BY rowid DESC LIMIT 1')
      .get(scopeId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as WorkflowState : undefined;
  }

  private summary(state: WorkflowState): unknown {
    return {
      workflowId: state.workflowId, plugin: { id: state.definition.id, version: state.definition.version, digest: state.definitionDigest },
      stateVersion: state.stateVersion, status: state.status, goalRef: state.artifacts[0]?.ref,
      goalPreview: state.goal.slice(0, 500),
      deadlineAt: state.deadlineAt, root: state.root,
      sessions: state.sessions,
      agents: state.agents ?? [],
      workQueue: state.workQueue ? workStatus(state) : undefined,
      consumers: consumerSummary(state),
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

  async call(caller: WorkflowCaller, method: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Workflow service is closed');
    if (caller.kind === 'worker') {
      if (method === 'checkpoint' || method === 'send_message' || WORK_MUTATIONS.includes(method)) {
        const root = await this.host.resolveRoot(caller.scopeId);
        if (this.closed) throw new Error('Workflow service is closed');
        const state = requireState(this.state(caller.scopeId, caller.workflowId));
        if (!root || !sameRoot(root, state.root)) throw new Error('Worker root binding changed');
      }
      return this.workerCall(caller, method, args);
    }
    if (!['status', 'read_artifact', 'run_script', 'replay_script', 'publish_artifact', 'ack_events', 'cancel_task', 'pause', 'resume', 'cancel', 'complete', 'send_message', 'read_checkpoint', 'enqueue_work', 'retry_work', 'close_work_queue', 'work_status'].includes(method)) {
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
    let state = this.state(scope, workflowId);
    if (method === 'status') return state ? this.summary(state) : { status: 'unbound' };
    if (method === 'read_artifact') return this.artifact(requireState(state), requiredText(args.ref));
    if (method === 'read_checkpoint') return checkpoint(requireState(state), member(requireState(state), requiredText(args.member, 100))) ?? null;
    if (method === 'work_status') return workStatus(requireState(state), { itemId: args.itemId, offset: args.offset, limit: args.limit });

    const operationId = requiredText(args.operationId, 200);
    const digest = workflowDigest({ method, args });
    const prior = this.db.prepare('SELECT digest, response FROM workflow_operations WHERE scope = ? AND id = ?')
      .get(scope, operationId) as { digest: string; response: string } | undefined;
    if (prior) {
      if (prior.digest !== digest) throw new Error('operationId conflict: same ID with different content');
      return JSON.parse(prior.response);
    }
    const root = await this.host.resolveRoot(scope);
    if (!root) throw new Error('No authorized active root session');
    const committed = this.db.prepare('SELECT digest, response FROM workflow_operations WHERE scope = ? AND id = ?')
      .get(scope, operationId) as { digest: string; response: string } | undefined;
    if (committed) {
      if (committed.digest !== digest) throw new Error('operationId conflict: same ID with different content');
      return JSON.parse(committed.response);
    }
    // The root may have changed while awaiting authorization.
    state = this.state(scope, workflowId);
    if (method === 'run_script') {
      if (state || this.state(scope)) throw new Error('Root already has a workflow; cancel or complete it first');
      const definition = structuredClone(SCRIPT_DEFINITION);
      definition.maxConcurrentWorkers = boundedInteger(args.maxConcurrent, 4, 1, 16);
      const goal = requiredText(args.goal);
      state = {
        workflowId: randomUUID(), root, definition, definitionDigest: workflowDigest(definition), goal,
        stateVersion: 0, status: 'active', createdAt: this.now(),
        deadlineAt: this.now() + boundedInteger(args.timeoutMs, 30 * 60_000, 1000, 120 * 60_000),
        sessions: [], tasks: [], artifacts: [], events: [],
      };
      this.addArtifact(state, 'requirements', goal);
      const source = this.addArtifact(state, 'workflow-script', scriptText(args.script, 'script'));
      const plan = this.addArtifact(state, 'workflow-plan', scriptText(args.plan, 'plan', 12_000));
      state.script = { name: scriptText(args.name ?? 'Script workflow', 'name', 100), sourceRef: source.ref, planRef: plan.ref,
        args: scriptArgs(args.args), defaults: workerSelection(args.execution, root), runId: randomUUID(), revision: 0,
        status: 'queued', maxCalls: boundedInteger(args.maxAgents, 32, 1, SCRIPT_MAX_TASKS), calls: [], logs: [] };
      return this.commitOperation(state, operationId, digest, () => this.summary(state!));
    }
    state = requireState(state);
    if (!state.script) throw new Error('Agent-led workflows have been retired; use run_script.');
    if (method !== 'cancel' && !sameRoot(root, state.root)) {
      this.invalidate(scope);
      throw new Error('Root binding changed; workflow needs attention');
    }
    if (args.expectedStateVersion !== state.stateVersion) throw new Error(`stateVersion conflict; current=${state.stateVersion}`);
    if (['completed', 'cancelled'].includes(state.status)) throw new Error('Workflow is terminal');
    if (method === 'cancel') {
      this.cancelState(state);
      return this.commitOperation(state, operationId, digest, () => this.summary(state!));
    }
    if (!['active', 'paused'].includes(state.status) && !(state.status === 'interrupted' && ['replay_script', 'send_message', 'enqueue_work', 'retry_work', 'close_work_queue'].includes(method))) {
      throw new Error(`Workflow is ${state.status}; cancel and start a new workflow, or explicitly replay an interrupted script`);
    }
    if (this.now() >= state.deadlineAt && !['ack_events', 'complete', 'cancel_task'].includes(method)) throw new Error('Workflow deadline reached');
    let response: unknown;
    switch (method) {
      case 'close_work_queue':
        if (Object.keys(args).some(key => !['workflowId', 'operationId', 'expectedStateVersion'].includes(key))) throw new Error('Unsupported close_work_queue option');
        response = closeWorkQueue(state, this.now());
        break;
      case 'enqueue_work':
        this.checkWorkKey(state, args.key);
        response = enqueueWork(state, Object.fromEntries(Object.entries(args).filter(([key]) => !['workflowId', 'operationId', 'expectedStateVersion'].includes(key))), this.now());
        break;
      case 'retry_work':
        response = retryWork(state, Object.fromEntries(Object.entries(args).filter(([key]) => !['workflowId', 'operationId', 'expectedStateVersion'].includes(key))), this.now());
        break;
      case 'send_message':
        response = sendMessage(state, requiredText(args.member, 100), args.text, this.now());
        break;
      case 'publish_artifact': {
        const kind = requiredText(args.kind, 100);
        if (!['context', 'report'].includes(kind)) throw new Error('Main artifacts support context and report');
        const artifact = this.addArtifact(state, kind, requiredText(args.text));
        response = { ref: artifact.ref, kind: artifact.kind, digest: artifact.digest };
        break;
      }
      case 'ack_events': {
        const ids = textArray(args.eventIds);
        if (ids.some(id => !state!.events.some(event => event.id === id))) throw new Error('Unknown event ID');
        for (const event of state.events) if (ids.includes(event.id)) event.acknowledged = true;
        response = { acknowledged: ids };
        break;
      }
      case 'cancel_task': {
        const task = this.task(state, requiredText(args.taskId));
        this.cancelTask(task, state);
        response = { taskId: task.taskId, status: task.status };
        break;
      }
      case 'pause':
        state.status = 'paused';
        state.script.status = 'paused';
        if (state.consumerPool) state.consumerPool.status = 'suspended';
        for (const task of state.tasks) if (BUSY.has(task.status)) this.cancelTask(task, state);
        break;
      case 'resume':
        if (state.script.status !== 'paused') throw new Error('Use replay_script to relaunch a completed or failed script');
        this.replayScript(state, args);
        break;
      case 'replay_script': this.replayScript(state, args); break;
      case 'complete': {
        if (!['result_ready', 'failed'].includes(state.script.status)) throw new Error('Script has not finished');
        if (state.tasks.some(task => BUSY.has(task.status))) throw new Error('Workers are still active');
        if (unfinishedWork(state)) throw new Error('Work items are unfinished; finish them or cancel the workflow');
        if (state.events.some(event => !event.acknowledged)) throw new Error('Acknowledge pending events before completion');
        const report = this.artifact(state, requiredText(args.reportRef));
        if (!['report', 'workflow-result'].includes(report.kind)) throw new Error('Completion requires a report or script result artifact');
        // A successful worker answer does not establish verification coverage.
        response = { reportRef: report.ref, openIssues: textArray(args.openIssues), verificationLimits: requiredText(args.verificationLimits) };
        state.status = 'completed';
        break;
      }
      default: throw new Error(`Unsupported workflow operation: ${method}`);
    }
    return this.commitOperation(state, operationId, digest, () => ({ stateVersion: state!.stateVersion, ...(response as object ?? { status: state!.status }) }));
  }

  private workerCall(caller: Extract<WorkflowCaller, { kind: 'worker' }>, method: string, args: Record<string, unknown>): unknown {
    const state = requireState(this.state(caller.scopeId, caller.workflowId));
    if (WORK_MUTATIONS.includes(method)) this.expireClaims(state);
    const task = this.task(state, caller.taskId);
    if (!['starting', 'running'].includes(task.status) || task.attempts.at(-1)?.attemptId !== caller.attemptId) throw new Error('Worker binding is inactive');
    const agent = taskAgent(state, task);
    if (agent && agent.activeTurnId !== task.taskId) throw new Error('Member turn is no longer active');
    if (method === 'task_status') return { taskId: task.taskId, status: task.status, checkpointVersion: agent?.checkpointVersion };
    if (method === 'read_context') return { goal: state.goal, objective: task.objective, inputRefs: task.inputRefs, member: memberContext(state, task), workQueue: workContext(state, task) };
    if (method === 'work_status') return workStatus(state, args);
    if (WORK_MUTATIONS.includes(method)) {
      if (state.status !== 'active' || state.script?.status !== 'running' || this.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
      const response = mutateWork(state, task, caller.attemptId, method, args, this.now());
      this.save(state);
      return response;
    }
    if (method === 'checkpoint' || method === 'send_message') {
      if (!agent) throw new Error('This operation requires a persistent member');
      if (state.status !== 'active' || state.script?.status !== 'running' || this.now() >= state.deadlineAt) throw new Error('Workflow is inactive');
      const operationId = requiredText(args.operationId, 160);
      const response = mailboxOperation(state, 'worker:' + task.taskId + ':' + operationId, { method, args }, () => {
        if (method === 'send_message') return sendMessage(state, requiredText(args.member, 100), args.text, this.now(), agent.agentId);
        if (args.expectedCheckpointVersion !== agent.checkpointVersion) throw new Error('checkpointVersion conflict; read_context before updating');
        const saved = saveCheckpoint(state, task, args.state, this.now());
        return { checkpointRef: saved.ref, checkpointVersion: saved.version };
      });
      this.save(state);
      return response;
    }
    if (method === 'read_artifact') {
      const ref = requiredText(args.ref);
      if (!task.inputRefs.includes(ref)) throw new Error('Artifact is outside worker input scope');
      return this.artifact(state, ref);
    }
    throw new Error('Operation not permitted for worker');
  }

  private commitOperation(state: WorkflowState, id: string, digest: string, result: () => unknown): unknown {
    return this.db.transaction(() => {
      this.save(state);
      const response = result();
      this.db.prepare('INSERT INTO workflow_operations(scope, id, digest, response) VALUES (?, ?, ?, ?)')
        .run(state.root.scopeId, id, digest, JSON.stringify(response));
      return response;
    })();
  }

  private save(state: WorkflowState): void {
    state.stateVersion++;
    this.db.prepare('INSERT INTO workflows(id, scope, status, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data')
      .run(state.workflowId, state.root.scopeId, state.status, JSON.stringify(state));
    this.changes.emit(state.root.scopeId);
  }

  onChange(scopeId: string, listener: () => void): () => void {
    this.changes.on(scopeId, listener);
    return () => { this.changes.off(scopeId, listener); };
  }

  queuedScripts(): WorkflowState[] {
    return this.list().filter(state => state.status === 'active' && state.script?.status === 'queued');
  }

  beginScript(scopeId: string, workflowId: string): { state: WorkflowState; source: string } | undefined {
    const state = this.state(scopeId, workflowId);
    if (!state || state.status !== 'active' || state.script?.status !== 'queued') return undefined;
    state.script.status = 'running';
    this.save(state);
    return { state, source: this.artifact(state, state.script.sourceRef).text };
  }

  async scriptAgent(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<{ taskId: string; output: 'text' | 'json' }> {
    if (this.closed) throw new Error('Workflow service is closed');
    const snapshot = requireState(this.state(scopeId, workflowId));
    if (!snapshot.script) throw new Error('Not a script workflow');
    const call = parseScriptAgentCall(input, snapshot.script.defaults, snapshot.root);
    const root = await this.host.resolveRoot(scopeId);
    if (!root || !sameRoot(root, snapshot.root)) throw new Error('Worker root authorization changed');
    const execution = await (this.host.resolveWorker?.(root, call.selection) ?? inheritedWorkerExecution(root, call.selection));
    const latestRoot = await this.host.resolveRoot(scopeId);
    if (!latestRoot || !sameRoot(root, latestRoot)) throw new Error('Worker root authorization changed');
    if (this.closed) throw new Error('Workflow service is closed');
    const state = requireState(this.state(scopeId, workflowId));
    const script = state.script!;
    if (state.status !== 'active' || script.runId !== runId || script.status !== 'running' || this.now() >= state.deadlineAt) throw new Error('Script run is inactive');
    if (state.consumerPool?.members.some(member => member.name === call.member)) throw new Error('Consumer pool members are reserved for consumeWork');
    if (call.key === state.consumerPool?.key || call.key === state.workQueue?.closeKey) throw new Error('Script key already belongs to a work queue operation');
    if (script.calls.some(item => item.key === call.key) || script.mailboxCalls?.includes(call.key) || state.workQueue?.items.some(item => item.key === call.key)) throw new Error(`Duplicate agent key: ${call.key}`);
    if (script.calls.length >= script.maxCalls) throw new Error('Script agent call limit reached');
    if (call.member) {
      const scheduled = scheduleMemberTurn(state, call, execution);
      script.calls.push({ key: call.key, taskId: scheduled.task.taskId, cached: scheduled.cached });
      this.save(state);
      return { taskId: scheduled.task.taskId, output: call.output };
    }
    const cacheKey = workflowDigest({ key: call.key, prompt: call.prompt, output: call.output, execution,
      root: state.root, goal: state.goal, definition: state.definitionDigest });
    const cached = state.tasks.find(task => task.cacheKey === cacheKey && task.status === 'result_ready');
    let task = cached;
    if (!task) {
      if (state.tasks.length >= SCRIPT_MAX_TASKS) throw new Error('Script task history limit reached');
      const sessionRef = randomUUID();
      const taskId = randomUUID();
      state.sessions.push({ sessionRef, actorId: randomUUID(), actorKey: taskId, role: 'worker', generation: 1,
        nativeIdKind: sessionIdFieldForAgent(execution.agentKind), execution });
      task = { taskId, taskKey: taskId, requestDigest: cacheKey, sessionRef, objective: call.prompt, inputRefs: [],
        status: 'queued', attempts: [], resultRefs: [], scriptRunId: runId, scriptKey: call.key, scriptOutput: call.output, cacheKey };
      state.tasks.push(task);
    }
    script.calls.push({ key: call.key, taskId: task.taskId, cached: Boolean(cached) });
    this.save(state);
    return { taskId: task.taskId, output: call.output };
  }

  private checkWorkKey(state: WorkflowState, value: unknown, operation: 'enqueue' | 'consume' | 'close' = 'enqueue'): string {
    const key = scriptText(value, 'work key', 160);
    if (key.startsWith('@consumer/') || operation !== 'consume' && key === state.consumerPool?.key
      || operation !== 'close' && key === state.workQueue?.closeKey
      || operation !== 'enqueue' && state.workQueue?.items.some(item => item.key === key)) throw new Error('Script key already belongs to another work queue operation');
    if (state.tasks.some(task => task.scriptKey === key) || state.mailbox?.receipts.some(receipt => receipt.key === key)
      || state.mailbox?.operations.some(operation => operation.key === 'script:' + key)) throw new Error('Script key already belongs to another operation: ' + key);
    return key;
  }

  async scriptWork(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<unknown> {
    if (this.closed) throw new Error('Workflow service is closed');
    const root = await this.host.resolveRoot(scopeId);
    if (this.closed) throw new Error('Workflow service is closed');
    let state = requireState(this.state(scopeId, workflowId));
    if (!root || !sameRoot(root, state.root)) throw new Error('Root binding changed');
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || this.now() >= state.deadlineAt) throw new Error('Script run is inactive');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid work queue call');
    const { kind, ...args } = input as Record<string, unknown>;
    if (kind === 'status') return workStatus(state, args);
    if (!['enqueue', 'consume', 'close'].includes(String(kind))) throw new Error('Unknown script work operation');
    const key = this.checkWorkKey(state, args.key, kind as 'enqueue' | 'consume' | 'close');
    if (state.script.workCalls?.includes(key)) throw new Error('Duplicate script key: ' + key);
    if ((state.script.workCalls?.length ?? 0) >= 128) throw new Error('Work queue script call limit reached');
    if (kind === 'consume') {
      const spec = parseConsumerPool(args, state);
      const executions = [];
      for (const member of spec.members) executions.push(await (this.host.resolveWorker?.(root, member.selection) ?? inheritedWorkerExecution(root, member.selection)));
      const currentRoot = await this.host.resolveRoot(scopeId);
      if (this.closed || !currentRoot || !sameRoot(root, currentRoot)) throw new Error('Consumer root authorization changed');
      state = requireState(this.state(scopeId, workflowId));
      if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || this.now() >= state.deadlineAt) throw new Error('Script run is inactive');
      this.checkWorkKey(state, key, 'consume');
      if ((state.script.workCalls?.length ?? 0) >= 128) throw new Error('Work queue script call limit reached');
      bindConsumerPool(state, spec, executions);
      (state.script.workCalls ??= []).push(key);
      this.save(state);
      return { consumerPool: key };
    }
    if (kind === 'close') {
      if (Object.keys(args).some(key => key !== 'key')) throw new Error('closeWorkQueue supports key only');
      if (state.workQueue?.closeKey && state.workQueue.closeKey !== key) throw new Error('Queue closure key changed across replay');
      const result = closeWorkQueue(state, this.now());
      state.workQueue!.closeKey = key;
      (state.script.workCalls ??= []).push(key);
      this.save(state);
      return result;
    }
    const response = enqueueWork(state, args, this.now());
    (state.script.workCalls ??= []).push(key);
    this.save(state);
    return response;
  }

  scriptConsumerResult(scopeId: string, workflowId: string, runId: string): unknown | undefined {
    const state = requireState(this.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running'
      || state.consumerPool?.runId !== runId) throw new Error('Consumer pool run is inactive');
    return consumerResult(state);
  }

  async scriptMailbox(scopeId: string, workflowId: string, runId: string, input: unknown): Promise<{ receiptId?: string; result?: unknown }> {
    if (this.closed) throw new Error('Workflow service is closed');
    const root = await this.host.resolveRoot(scopeId);
    const state = requireState(this.state(scopeId, workflowId));
    if (!root || !sameRoot(root, state.root)) throw new Error('Root binding changed');
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running' || this.now() >= state.deadlineAt) throw new Error('Script run is inactive');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid mailbox call');
    const args = input as Record<string, unknown>;
    if (Object.keys(args).some(key => !['kind', 'member', 'text', 'key'].includes(key))) throw new Error('Unsupported mailbox option');
    if (args.kind !== 'send' && args.kind !== 'receive') throw new Error('Unknown mailbox operation');
    if (args.kind === 'receive' && Object.hasOwn(args, 'text')) throw new Error('receive() does not accept text');
    const key = scriptText(args.key, 'mailbox key', 160);
    const target = scriptText(args.member, 'member name', 100);
    if (key.startsWith('@consumer/') || key === state.consumerPool?.key || key === state.workQueue?.closeKey) throw new Error('Script key already belongs to a work queue operation');
    if (args.kind === 'receive' && state.consumerPool?.members.some(member => member.name === target)) throw new Error('Consumer pool members cannot wait on script receive()');
    if (key.trim() !== key) throw new Error('Mailbox key must not contain surrounding whitespace');
    if (state.script.calls.some(call => call.key === key) || state.script.mailboxCalls?.includes(key) || state.workQueue?.items.some(item => item.key === key)) throw new Error('Duplicate script key: ' + key);
    if ((state.script.mailboxCalls?.length ?? 0) >= 128) throw new Error('Mailbox call limit reached');
    if (args.kind === 'receive' ? state.mailbox?.operations.some(item => item.key === 'script:' + key)
      : state.mailbox?.receipts.some(item => item.key === key)) throw new Error('Mailbox key changed operation kind');
    const result = args.kind === 'send'
      ? { result: mailboxOperation(state, 'script:' + key, args, () => sendMessage(state, target, args.text, this.now())) }
      : { receiptId: receiveMessages(state, target, key).id };
    (state.script.mailboxCalls ??= []).push(key);
    this.save(state);
    return result;
  }

  scriptMailboxResult(scopeId: string, workflowId: string, runId: string, receiptId: string): unknown[] | undefined {
    const state = requireState(this.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running') throw new Error('Script run is inactive');
    return receiptMessages(state, receiptId);
  }

  scriptTaskResult(scopeId: string, workflowId: string, runId: string, taskId: string): string | undefined {
    const state = requireState(this.state(scopeId, workflowId));
    if (state.status !== 'active' || state.script?.runId !== runId || state.script.status !== 'running') throw new Error('Script run is inactive');
    const task = this.task(state, taskId);
    if (task.status === 'result_ready') return this.artifact(state, task.resultRefs.at(-1)!).text;
    if (['failed', 'cancelled', 'interrupted', 'waiting_input'].includes(task.status)) throw new Error(task.error ?? `Agent ${task.scriptKey} is ${task.status}`);
    return undefined;
  }

  scriptProgress(scopeId: string, workflowId: string, runId: string, kind: 'phase' | 'log', text: string): void {
    const state = this.state(scopeId, workflowId);
    if (!state?.script || state.script.runId !== runId || state.script.status !== 'running') return;
    if (kind === 'phase') state.script.phase = text.slice(0, 200);
    else state.script.logs = [...state.script.logs, text.slice(0, 1000)].slice(-50);
    this.save(state);
  }

  finishScript(scopeId: string, workflowId: string, runId: string, result: { text: string } | { error: string }): void {
    const state = this.state(scopeId, workflowId);
    if (!state?.script || state.script.runId !== runId || state.script.status !== 'running' || state.status !== 'active') return;
    if ('text' in result && state.consumerPool && ['running', 'waiting'].includes(state.consumerPool.status)) result = { error: 'Consumer pool is unfinished; await consumeWork and close the queue when production is finished' };
    if ('text' in result && unfinishedWork(state)) result = { error: 'Script returned with unfinished work items; continue consumption or explicitly cancel the workflow.' };
    if ('text' in result) {
      scriptText(result.text, 'script result');
      const artifact = this.addArtifact(state, 'workflow-result', result.text);
      state.script.resultRef = artifact.ref;
      state.script.status = 'result_ready';
      this.event(state, { kind: 'script_result_ready', artifactRef: artifact.ref, summary: 'Script result ready for main-agent review.' });
    } else {
      state.script.status = 'failed';
      state.script.error = result.error.slice(0, 2000);
      if (state.consumerPool && ['waiting', 'running'].includes(state.consumerPool.status)) {
        state.consumerPool.status = 'failed'; state.consumerPool.reason = state.script.error;
      }
      for (const task of state.tasks) if (task.scriptRunId === runId && BUSY.has(task.status)) this.cancelTask(task, state);
      this.event(state, { kind: 'script_failed', summary: state.script.error });
    }
    this.save(state);
  }

  plan(scopeId: string, workflowId?: string): string {
    const state = requireState(this.state(scopeId, workflowId));
    if (!state.script) throw new Error('Workflow has no script plan');
    const plan = state.script.planRef
      ? this.artifact(state, state.script.planRef).text
      : `旧版实例没有保存文字方案。原始执行脚本：\n\n${this.artifact(state, state.script.sourceRef).text}`;
    return renderWorkflowPlan(state, plan);
  }

  private replayScript(state: WorkflowState, args: Record<string, unknown>): void {
    const script = state.script;
    if (!script) throw new Error('Not a script workflow');
    if (['queued', 'running'].includes(script.status) || state.tasks.some(task => BUSY.has(task.status))) throw new Error('Stop or pause the script and wait for workers to finish before replay');
    if (script.revision >= SCRIPT_MAX_REVISIONS) throw new Error('Script replay limit reached');
    if (args.script !== undefined || Object.hasOwn(args, 'args') || args.execution !== undefined || !script.planRef) {
      scriptText(args.plan, 'updated plan', 12_000);
    }
    if (args.plan !== undefined) script.planRef = this.addArtifact(state, 'workflow-plan', scriptText(args.plan, 'plan', 12_000)).ref;
    if (args.script !== undefined) script.sourceRef = this.addArtifact(state, 'workflow-script', scriptText(args.script, 'script')).ref;
    if (Object.hasOwn(args, 'args')) script.args = scriptArgs(args.args);
    if (args.execution !== undefined) script.defaults = workerSelection(args.execution, state.root);
    script.runId = randomUUID(); script.revision++; script.status = 'queued';
    script.calls = []; script.mailboxCalls = []; script.workCalls = []; script.logs = []; script.error = undefined; script.resultRef = undefined; script.phase = undefined;
    state.status = 'active';
    for (const event of state.events) if (['script_result_ready', 'script_failed'].includes(event.kind)) event.acknowledged = true;
  }

  private task(state: WorkflowState, id: string): WorkflowTask {
    const task = state.tasks.find(item => item.taskId === id);
    if (!task) throw new Error('Task not found in workflow');
    return task;
  }

  private artifact(state: WorkflowState, ref: string): WorkflowArtifact {
    const artifact = state.artifacts.find(item => item.ref === ref);
    if (!artifact) throw new Error('Artifact not found in workflow');
    if (workflowDigest(artifact.text) !== artifact.digest) throw new Error('Artifact digest mismatch');
    return artifact;
  }

  private addArtifact(state: WorkflowState, kind: string, text: string, task?: WorkflowTask): WorkflowArtifact {
    const artifact: WorkflowArtifact = { ref: `artifact:${randomUUID()}`, kind, text, digest: workflowDigest(text), createdAt: this.now(),
      ...(task ? { taskId: task.taskId, attemptId: task.attempts.at(-1)?.attemptId } : {}) };
    state.artifacts.push(artifact);
    return artifact;
  }

  private event(state: WorkflowState, event: Omit<WorkflowEvent, 'id' | 'acknowledged' | 'notified'>): void {
    state.events.push({ ...event, id: randomUUID(), acknowledged: false, notified: false });
  }

  hasWake(scopeId: string): boolean {
    const state = this.state(scopeId);
    return Boolean(state && ['active', 'paused'].includes(state.status) && state.events.some(event => !event.acknowledged && !event.notified));
  }

  markNotified(scopeId: string, ids: string[]): void {
    const state = this.state(scopeId);
    if (!state) return;
    for (const event of state.events) if (ids.includes(event.id)) event.notified = true;
    this.save(state);
  }

  invalidate(scopeId: string): void {
    const state = this.state(scopeId);
    if (!state || ['binding_attention', 'interrupted'].includes(state.status)) return;
    state.status = 'binding_attention';
    if (state.script) state.script.status = 'interrupted';
    if (state.consumerPool) state.consumerPool.status = 'suspended';
    for (const task of state.tasks) if (BUSY.has(task.status)) this.cancelTask(task, state);
    this.event(state, { kind: 'binding_attention', summary: 'Root session, model, workspace or policy changed; new delegation stopped.' });
    this.save(state);
  }

  cancel(scopeId: string): boolean {
    const state = this.state(scopeId);
    if (!state) return false;
    this.cancelState(state);
    this.save(state);
    return true;
  }

  private cancelState(state: WorkflowState): void {
    state.status = 'cancelled';
    if (state.script) state.script.status = 'cancelled';
    if (state.consumerPool) state.consumerPool.status = 'cancelled';
    cancelWork(state, this.now());
    for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_input') this.cancelTask(task, state);
  }

  private expireClaims(state: WorkflowState): void {
    const expired = expireWorkClaims(state, this.now());
    if (!expired.length) return;
    for (const claim of expired) {
      const task = state.tasks.find(task => task.taskId === claim.taskId);
      if (task && task.attempts.at(-1)?.attemptId === claim.attemptId && BUSY.has(task.status)) {
        task.error = 'Work claim lease expired; saved work progress is available to another member';
        this.cancelTask(task, state);
      }
    }
    this.save(state);
  }

  private cancelTask(task: WorkflowTask, state: WorkflowState): void {
    releaseWorkClaims(state, this.now(), 'Member execution cancelled', task.taskId);
    const active = this.running.get(task.taskId);
    task.status = active ? 'cancelling' : 'cancelled';
    active?.controller.abort();
  }

  async tick(): Promise<void> {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      for (const snapshot of this.list()) {
        if (!['active', 'paused'].includes(snapshot.status)) continue;
        const root = await this.host.resolveRoot(snapshot.root.scopeId);
        if (this.closed) return;
        const state = this.state(snapshot.root.scopeId, snapshot.workflowId)!;
        if (!['active', 'paused'].includes(state.status)) continue;
        this.expireClaims(state);
        if (!root || !sameRoot(root, state.root)) { this.invalidate(state.root.scopeId); continue; }
        if (this.now() >= state.deadlineAt && state.status === 'active') {
          state.status = 'paused';
          if (state.script) state.script.status = 'paused';
          if (state.consumerPool) state.consumerPool.status = 'suspended';
          for (const task of state.tasks) if (BUSY.has(task.status)) this.cancelTask(task, state);
          this.event(state, { kind: 'budget_attention', summary: 'Workflow deadline reached; workers cancelled.' });
          this.save(state);
        }
        if (state.status === 'active') {
          if (pumpConsumerPool(state)) this.save(state);
          let active = state.tasks.filter(task => this.running.has(task.taskId)).length;
          for (const task of state.tasks) {
            if (task.status !== 'queued' || active >= state.definition.maxConcurrentWorkers) continue;
            if (state.tasks.reduce((count, item) => count + item.attempts.length, 0) >= SCRIPT_MAX_TASKS) {
              task.status = 'failed'; task.error = 'Workflow attempt limit reached'; this.save(state); continue;
            }
            task.status = 'starting';
            const attemptId = randomUUID();
            const agent = taskAgent(state, task);
            const session = state.sessions.find(item => item.sessionRef === task.sessionRef)!;
            task.attempts.push({ attemptId, startedAt: this.now(), checkpointVersion: agent?.checkpointVersion, sessionGeneration: session.generation });
            const controller = new AbortController();
            this.save(state);
            // Register before asynchronous execution can produce an event or a cancellation.
            const done = Promise.resolve().then(() => this.execute(state.workflowId, state.root.scopeId, task.taskId, attemptId, controller.signal));
            this.running.set(task.taskId, { controller, done });
            void done.finally(() => this.running.delete(task.taskId)).catch(error => log.warn('workflow', 'worker-failed', { error: String(error) }));
            active++;
          }
        }
        if (this.hasWake(state.root.scopeId) && !this.waking.has(state.root.scopeId)) {
          const scope = state.root.scopeId;
          this.waking.add(scope);
          void this.host.wakeMain(scope).catch(error => log.warn('workflow', 'wake-failed', { error: String(error) }))
            .finally(() => this.waking.delete(scope));
        }
      }
    } finally { this.pumping = false; }
  }

  private async execute(workflowId: string, scopeId: string, taskId: string, attemptId: string, signal: AbortSignal): Promise<void> {
    let result: WorkflowWorkerResult;
    try {
      const workflow = requireState(this.state(scopeId, workflowId));
      const task = this.task(workflow, taskId);
      const session = workflow.sessions.find(item => item.sessionRef === task.sessionRef)!;
      const role = workflow.definition.roles[session.role]!;
      const inputs = task.inputRefs.map(ref => this.artifact(workflow, ref));
      const prompt = [role.instructions,
        task.agentId ? '只执行指定任务，遵守原始需求的授权范围。可保存 checkpoint 或发送工作流内部消息；不要发外部消息或再委派子 agent。结果以最终答复返回脚本。' : '只执行指定任务，遵守原始需求的授权范围。不要自行发消息或再委派子 agent。结果以最终答复返回脚本。',
        `需求：\n${workflow.goal}`, `任务：\n${task.objective}`, `明确输入产物：\n${JSON.stringify(inputs)}`].join('\n\n');
      const recovery = memberContext(workflow, task);
      const memberPrompt = recovery ? prompt + '\n\n持久成员上下文（只处理本轮输入；检查已发生的副作用，避免重复执行）：\n'
        + JSON.stringify(recovery) + (workflow.workQueue ? '\n\n工作队列：\n' + JSON.stringify(workContext(workflow, task)) : '') : prompt;
      signal.throwIfAborted();
      result = await this.host.execute({ workflow, task, session, attemptId, prompt: memberPrompt, signal,
        onRun: runId => this.updateAttempt(scopeId, workflowId, taskId, attemptId, state => {
          const current = this.task(state, taskId);
          current.attempts.at(-1)!.runId = runId;
          current.status = 'running';
        }),
        onSession: (nativeId, model) => this.updateAttempt(scopeId, workflowId, taskId, attemptId, state => {
          const binding = state.sessions.find(item => item.sessionRef === session.sessionRef)!;
          if (binding.nativeSessionId && binding.nativeSessionId !== nativeId) throw new Error('Backend replaced the native worker session');
          binding.nativeSessionId = nativeId;
          if (model) binding.observedModel = model;
        }),
      });
    } catch (error) { result = { status: 'failed', error: String(error) }; }
    const state = requireState(this.state(scopeId, workflowId));
    const task = this.task(state, taskId);
    if (task.attempts.at(-1)?.attemptId !== attemptId) return;
    releaseWorkClaims(state, this.now(), 'Member turn ended without completing its claim', taskId, attemptId);
    if (task.agentId && result.status === 'completed' && !state.sessions.find(session => session.sessionRef === task.sessionRef)?.nativeSessionId) {
      result = { status: 'failed', error: 'Member completed without a native session ID; cannot safely continue its conversation' };
    }
    if (task.scriptOutput === 'json' && result.status === 'completed') {
      try { JSON.parse(result.text ?? ''); }
      catch { result = { status: 'failed', error: 'Agent output is not valid JSON' }; }
    }
    task.attempts.at(-1)!.endedAt = this.now();
    task.attempts.at(-1)!.result = result.status;
    if (signal.aborted || task.status === 'cancelling' || state.status === 'cancelled' || state.status === 'binding_attention') {
      task.status = 'cancelled';
    } else if (result.question) {
      task.status = 'waiting_input';
      task.error = `Worker requires input: ${result.question.slice(0, 1800)}`;
    } else if (result.status === 'completed' && result.text?.trim() && result.text.length <= MAX_TEXT) {
      const session = state.sessions.find(item => item.sessionRef === task.sessionRef)!;
      const artifact = this.addArtifact(state, state.definition.roles[session.role]!.outputKind, result.text, task);
      task.resultRefs.push(artifact.ref);
      task.status = 'result_ready';
      completeMemberTurn(state, task, artifact.ref, this.now());
    } else {
      task.status = 'failed';
      task.error = result.error ?? 'Worker did not produce a bounded final answer with a normal terminal result';
    }
    this.save(state);
  }

  private updateAttempt(scope: string, workflowId: string, taskId: string, attemptId: string, update: (state: WorkflowState) => void): void {
    const state = requireState(this.state(scope, workflowId));
    const task = this.task(state, taskId);
    if (!['starting', 'running'].includes(task.status) || task.attempts.at(-1)?.attemptId !== attemptId) return;
    update(state);
    this.save(state);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { controller } of this.running.values()) controller.abort();
    await Promise.allSettled([...this.running.values()].map(run => run.done));
    this.db.close();
  }
}

function sameRoot(a: WorkflowRoot, b: WorkflowRoot): boolean { return workflowDigest(a) === workflowDigest(b); }
function requireState(state: WorkflowState | undefined): WorkflowState {
  if (!state) throw new Error('Workflow not found in current root scope');
  return state;
}
function requiredText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Expected nonempty string of at most ${max} characters`);
  return value;
}
function optionalText(value: unknown): string | undefined { return value === undefined ? undefined : requiredText(value, 200); }
function textArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Expected bounded string array');
  return value.map(item => requiredText(item));
}
