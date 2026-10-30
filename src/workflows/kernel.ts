import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { sessionIdFieldForAgent } from '../agent/backend-spec';
import { log } from '../core/logger';
import { workflowDefinition, workflowDigest } from './definitions';
import { inheritedWorkerExecution, workerSelection } from './execution';
import { boundedInteger, parseScriptAgentCall, scriptArgs, scriptText, SCRIPT_DEFINITION, SCRIPT_MAX_REVISIONS, SCRIPT_MAX_TASKS } from './script-contract';
import type {
  WorkflowArtifact, WorkflowCaller, WorkflowEvent, WorkflowHost, WorkflowRoot,
  WorkflowState, WorkflowTask, WorkflowWorkerResult,
} from './types';

const BUSY = new Set<WorkflowTask['status']>(['queued', 'starting', 'running', 'cancelling']);
const MAX_TEXT = 100_000;
const MAX_TASKS = 32;

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
    // P0 preserves evidence but never guesses whether a pre-crash side effect ran.
    for (const state of this.list()) {
      if (['completed', 'cancelled'].includes(state.status)) continue;
      state.status = 'interrupted';
      if (state.script) state.script.status = 'interrupted';
      for (const task of state.tasks) if (BUSY.has(task.status)) {
        task.status = 'interrupted';
        task.error = 'Bridge restarted; P0 does not automatically resume workers.';
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
      : '当前没有绑定工作流。用户要求架构设计多 agent 协作时可 start architecture-review；要求脚本编排或跨 harness 工作流时可 run_script。普通问答不自动启动。';
  }

  private summary(state: WorkflowState): unknown {
    return {
      workflowId: state.workflowId, plugin: { id: state.definition.id, version: state.definition.version, digest: state.definitionDigest },
      stateVersion: state.stateVersion, status: state.status, goalRef: state.artifacts[0]?.ref,
      goalPreview: state.goal.slice(0, 500), revisionRound: state.revisionRound,
      deadlineAt: state.deadlineAt, root: state.root,
      sessions: state.sessions,
      tasks: state.tasks.map(({ taskId, taskKey, sessionRef, status, resultRefs, error, inputs, attempts, scriptKey }) =>
        ({ taskId, taskKey, sessionRef, status, resultRefs, error, scriptKey, inputs: inputs.map(({ inputId, receipt }) => ({ inputId, receipt })), attempts })),
      artifacts: state.artifacts.map(({ text: _text, ...artifact }) => artifact),
      events: state.events.filter(event => !event.acknowledged),
      ...(state.script ? { script: { ...state.script, args: undefined, argsDigest: workflowDigest(state.script.args) } } : {}),
      executionAccess: 'same authorized profile; role read-only instructions are not a sandbox',
    };
  }

  async call(caller: WorkflowCaller, method: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Workflow service is closed');
    if (caller.kind === 'worker') return this.workerCall(caller, method, args);
    const scope = caller.scopeId;
    let state = this.state(scope, optionalText(args.workflowId));
    if (method === 'status') return state ? this.summary(state) : { status: 'unbound' };
    if (method === 'read_artifact') return this.artifact(requireState(state), requiredText(args.ref));

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
    const selection = method === 'delegate' ? workerSelection(args.execution, root) : undefined;
    const workerExecution = selection
      ? await (this.host.resolveWorker?.(root, selection) ?? inheritedWorkerExecution(root, selection)) : undefined;
    if (selection && workflowDigest(root) !== workflowDigest(await this.host.resolveRoot(scope))) {
      throw new Error('Root binding changed while resolving worker execution');
    }
    const committed = this.db.prepare('SELECT digest, response FROM workflow_operations WHERE scope = ? AND id = ?')
      .get(scope, operationId) as { digest: string; response: string } | undefined;
    if (committed) {
      if (committed.digest !== digest) throw new Error('operationId conflict: same ID with different content');
      return JSON.parse(committed.response);
    }
    // The root may have changed while awaiting authorization.
    state = this.state(scope, optionalText(args.workflowId));
    if (method === 'start' || method === 'run_script') {
      if (state || this.state(scope)) throw new Error('Root already has a workflow; cancel or complete it first');
      const definition = method === 'run_script' ? structuredClone(SCRIPT_DEFINITION) : workflowDefinition(requiredText(args.pluginId, 100));
      if (method === 'run_script') definition.maxConcurrentWorkers = boundedInteger(args.maxConcurrent, 4, 1, 16);
      const goal = requiredText(args.goal);
      state = {
        workflowId: randomUUID(), root, definition, definitionDigest: workflowDigest(definition), goal,
        stateVersion: 0, revisionRound: 0, status: 'active', createdAt: this.now(),
        deadlineAt: this.now() + (method === 'run_script' ? boundedInteger(args.timeoutMs, 30 * 60_000, 1000, 120 * 60_000) : definition.maxWallTimeMinutes * 60_000),
        sessions: [], tasks: [], artifacts: [], events: [],
      };
      this.addArtifact(state, 'requirements', goal);
      if (method === 'run_script') {
        const source = this.addArtifact(state, 'workflow-script', scriptText(args.script, 'script'));
        state.script = { name: scriptText(args.name ?? 'Script workflow', 'name', 100), sourceRef: source.ref,
          args: scriptArgs(args.args), defaults: workerSelection(args.execution, root), runId: randomUUID(), revision: 0,
          status: 'queued', maxCalls: boundedInteger(args.maxAgents, 32, 1, SCRIPT_MAX_TASKS), calls: [], logs: [] };
      }
      return this.commitOperation(state, operationId, digest, () => this.summary(state!));
    }
    state = requireState(state);
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
    if (!['active', 'paused'].includes(state.status) && !(state.script && state.status === 'interrupted' && method === 'replay_script')) {
      throw new Error(`Workflow is ${state.status}; cancel and start a new workflow, or explicitly replay an interrupted script`);
    }
    if (this.now() >= state.deadlineAt && !['ack_events', 'complete', 'cancel_task'].includes(method)) throw new Error('Workflow deadline reached');
    let response: unknown;
    switch (method) {
      case 'delegate': {
        if (state.script) throw new Error('Script workflows own their tasks; edit and replay the script instead of delegate');
        if (state.status !== 'active') throw new Error('Workflow is paused');
        const taskKey = requiredText(args.taskKey, 200);
        const requestDigest = workflowDigest({ role: args.role, actorKey: args.actorKey, objective: args.objective, inputRefs: args.inputRefs, execution: args.execution });
        const existing = state.tasks.find(task => task.taskKey === taskKey);
        if (existing) {
          if (existing.requestDigest !== requestDigest) throw new Error('taskKey conflict');
          response = { taskId: existing.taskId, sessionRef: existing.sessionRef };
          break;
        }
        if (state.tasks.length >= MAX_TASKS) throw new Error('Workflow task limit reached');
        const role = requiredText(args.role, 100);
        if (!Object.hasOwn(state.definition.roles, role)) throw new Error('Role is not enabled in this plugin');
        const actorKey = requiredText(args.actorKey, 200);
        if (state.sessions.some(session => session.actorKey === actorKey)) throw new Error('actorKey exists; use send to continue the original session');
        const inputRefs = textArray(args.inputRefs ?? []);
        for (const ref of inputRefs) {
          const artifact = this.artifact(state, ref);
          if (role.startsWith('designer-') && artifact.taskId) {
            const source = state.tasks.find(task => task.taskId === artifact.taskId);
            const sourceRole = state.sessions.find(session => session.sessionRef === source?.sessionRef)?.role;
            if (sourceRole?.startsWith('designer-')) throw new Error('Independent designers cannot receive another designer proposal');
          }
        }
        const sessionRef = randomUUID();
        const actorId = randomUUID();
        state.sessions.push({ sessionRef, actorId, actorKey, role, generation: 1, execution: workerExecution,
          nativeIdKind: sessionIdFieldForAgent(workerExecution!.agentKind) });
        const task: WorkflowTask = { taskId: randomUUID(), taskKey, requestDigest, sessionRef,
          objective: requiredText(args.objective), inputRefs, status: 'queued', attempts: [], inputs: [], resultRefs: [] };
        state.tasks.push(task);
        response = { taskId: task.taskId, actorId, sessionRef, status: 'queued' };
        break;
      }
      case 'send': {
        if (state.script) throw new Error('Script workflows own their tasks; edit and replay the script instead of send');
        if (state.status !== 'active') throw new Error('Workflow is paused');
        if (args.execution !== undefined) throw new Error('send cannot change worker execution; delegate a new actor instead');
        const task = this.task(state, requiredText(args.taskId));
        const inputId = requiredText(args.inputId, 200);
        const text = requiredText(args.text);
        const existing = task.inputs.find(input => input.inputId === inputId);
        if (existing) {
          if (existing.text !== text) throw new Error('inputId conflict');
          response = { taskId: task.taskId, inputId, receipt: existing.receipt };
          break;
        }
        // P0 intentionally exposes queued resume, never ambiguous active input retransmission.
        if (BUSY.has(task.status)) throw new Error('Session is busy; send after its current attempt finishes');
        if (task.status === 'cancelled' || task.status === 'interrupted') throw new Error('Task cannot be resumed');
        if (!state.sessions.find(session => session.sessionRef === task.sessionRef)?.nativeSessionId) throw new Error('Native session unavailable; cannot silently replace it');
        if (task.attempts.length >= 8) throw new Error('Task attempt limit reached');
        task.inputs.push({ inputId, text, receipt: 'queued' });
        task.status = 'queued';
        task.error = undefined;
        response = { taskId: task.taskId, inputId, receipt: 'queued' };
        break;
      }
      case 'publish_artifact': {
        const kind = requiredText(args.kind, 100);
        if (!['context', 'architecture-decision'].includes(kind)) throw new Error('P0 main artifacts support context and architecture-decision');
        const artifact = this.addArtifact(state, kind, requiredText(args.text));
        response = { ref: artifact.ref, kind: artifact.kind, digest: artifact.digest };
        break;
      }
      case 'begin_revision_round':
        if (state.revisionRound >= state.definition.maxRevisionRounds) throw new Error('Revision round limit reached');
        response = { revisionRound: ++state.revisionRound };
        break;
      case 'ack_events': {
        const ids = textArray(args.eventIds);
        if (ids.some(id => !state!.events.some(event => event.id === id))) throw new Error('Unknown event ID');
        for (const event of state.events) if (ids.includes(event.id)) event.acknowledged = true;
        response = { acknowledged: ids };
        break;
      }
      case 'cancel_task': {
        const task = this.task(state, requiredText(args.taskId));
        this.cancelTask(task);
        response = { taskId: task.taskId, status: task.status };
        break;
      }
      case 'pause':
        state.status = 'paused';
        if (state.script) {
          state.script.status = 'paused';
          for (const task of state.tasks) if (BUSY.has(task.status)) this.cancelTask(task);
        }
        break;
      case 'resume':
        if (!state.script) { state.status = 'active'; break; }
        if (state.script.status !== 'paused') throw new Error('Use replay_script to relaunch a completed or failed script');
        this.replayScript(state, args);
        break;
      case 'replay_script': this.replayScript(state, args); break;
      case 'complete': {
        if (state.script && !['result_ready', 'failed'].includes(state.script.status)) throw new Error('Script has not finished');
        if (state.tasks.some(task => BUSY.has(task.status))) throw new Error('Workers are still active');
        if (state.events.some(event => !event.acknowledged)) throw new Error('Acknowledge pending events before completion');
        const report = this.artifact(state, requiredText(args.reportRef));
        if (report.kind !== 'architecture-decision' && !(state.script && report.kind === 'workflow-result')) throw new Error('Completion requires a decision or script result artifact');
        // Text P0 cannot validate evidence coverage; require explicit disclosure in the completion receipt.
        response = { reportRef: report.ref, openIssues: textArray(args.openIssues), verificationLimits: requiredText(args.verificationLimits) };
        state.status = 'completed';
        break;
      }
      default: throw new Error(`Unsupported P0 workflow operation: ${method}`);
    }
    return this.commitOperation(state, operationId, digest, () => ({ stateVersion: state!.stateVersion, ...(response as object ?? { status: state!.status }) }));
  }

  private workerCall(caller: Extract<WorkflowCaller, { kind: 'worker' }>, method: string, args: Record<string, unknown>): unknown {
    const state = requireState(this.state(caller.scopeId, caller.workflowId));
    const task = this.task(state, caller.taskId);
    if (!['starting', 'running'].includes(task.status) || task.attempts.at(-1)?.attemptId !== caller.attemptId) throw new Error('Worker binding is inactive');
    if (method === 'task_status') return { taskId: task.taskId, status: task.status };
    if (method === 'read_context') return { goal: state.goal, objective: task.objective, inputRefs: task.inputRefs };
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
    if (script.calls.some(item => item.key === call.key)) throw new Error(`Duplicate agent key: ${call.key}`);
    if (script.calls.length >= script.maxCalls) throw new Error('Script agent call limit reached');
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
        status: 'queued', attempts: [], inputs: [], resultRefs: [], scriptRunId: runId, scriptKey: call.key, scriptOutput: call.output, cacheKey };
      state.tasks.push(task);
    }
    script.calls.push({ key: call.key, taskId: task.taskId, cached: Boolean(cached) });
    this.save(state);
    return { taskId: task.taskId, output: call.output };
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
    if ('text' in result) {
      scriptText(result.text, 'script result');
      const artifact = this.addArtifact(state, 'workflow-result', result.text);
      state.script.resultRef = artifact.ref;
      state.script.status = 'result_ready';
      this.event(state, { kind: 'script_result_ready', artifactRef: artifact.ref, summary: 'Script result ready for main-agent review.' });
    } else {
      state.script.status = 'failed';
      state.script.error = result.error.slice(0, 2000);
      for (const task of state.tasks) if (task.scriptRunId === runId && BUSY.has(task.status)) this.cancelTask(task);
      this.event(state, { kind: 'script_failed', summary: state.script.error });
    }
    this.save(state);
  }

  private replayScript(state: WorkflowState, args: Record<string, unknown>): void {
    const script = state.script;
    if (!script) throw new Error('Not a script workflow');
    if (['queued', 'running'].includes(script.status) || state.tasks.some(task => BUSY.has(task.status))) throw new Error('Stop or pause the script and wait for workers to finish before replay');
    if (script.revision >= SCRIPT_MAX_REVISIONS) throw new Error('Script replay limit reached');
    if (args.script !== undefined) script.sourceRef = this.addArtifact(state, 'workflow-script', scriptText(args.script, 'script')).ref;
    if (Object.hasOwn(args, 'args')) script.args = scriptArgs(args.args);
    if (args.execution !== undefined) script.defaults = workerSelection(args.execution, state.root);
    script.runId = randomUUID(); script.revision++; script.status = 'queued';
    script.calls = []; script.logs = []; script.error = undefined; script.resultRef = undefined; script.phase = undefined;
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
    for (const task of state.tasks) if (BUSY.has(task.status)) this.cancelTask(task);
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
    for (const task of state.tasks) if (BUSY.has(task.status) || task.status === 'waiting_input') this.cancelTask(task);
  }

  private cancelTask(task: WorkflowTask): void {
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
        if (!root || !sameRoot(root, state.root)) { this.invalidate(state.root.scopeId); continue; }
        if (this.now() >= state.deadlineAt && state.status === 'active') {
          state.status = 'paused';
          if (state.script) state.script.status = 'paused';
          for (const task of state.tasks) if (BUSY.has(task.status)) this.cancelTask(task);
          this.event(state, { kind: 'budget_attention', summary: 'Workflow deadline reached; workers cancelled.' });
          this.save(state);
        }
        if (state.status === 'active') {
          let active = state.tasks.filter(task => this.running.has(task.taskId)).length;
          for (const task of state.tasks) {
            if (task.status !== 'queued' || active >= state.definition.maxConcurrentWorkers) continue;
            task.status = 'starting';
            const attemptId = randomUUID();
            task.attempts.push({ attemptId, startedAt: this.now() });
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
      const instructions = workflow.script
        ? '只执行指定任务，遵守原始需求的授权范围。不要自行发消息或再委派子 agent。结果以最终答复返回脚本。'
        : '只做文本分析。不要修改项目、执行共享测试、发送飞书消息或再委派子 agent。结果以最终答复返回主 agent。';
      const prompt = [role.instructions, instructions,
        `需求：\n${workflow.goal}`, `任务：\n${task.objective}`,
        `明确输入产物：\n${JSON.stringify(inputs)}`, ...task.inputs.filter(input => input.receipt === 'queued').map(input => `主 agent 补充：\n${input.text}`)].join('\n\n');
      signal.throwIfAborted();
      result = await this.host.execute({ workflow, task, session, attemptId, prompt, signal,
        onRun: runId => this.updateAttempt(scopeId, workflowId, taskId, attemptId, state => {
          const current = this.task(state, taskId);
          current.attempts.at(-1)!.runId = runId;
          current.status = 'running';
          for (const input of current.inputs) if (input.receipt === 'queued') input.receipt = 'submitted';
        }),
        onSession: (nativeId, model) => this.updateAttempt(scopeId, workflowId, taskId, attemptId, state => {
          const binding = state.sessions.find(item => item.sessionRef === session.sessionRef)!;
          if (binding.nativeSessionId && binding.nativeSessionId !== nativeId) throw new Error('Backend replaced the native session during resume');
          binding.nativeSessionId = nativeId;
          if (model) binding.observedModel = model;
        }),
      });
    } catch (error) { result = { status: 'failed', error: String(error) }; }
    const state = requireState(this.state(scopeId, workflowId));
    const task = this.task(state, taskId);
    if (task.attempts.at(-1)?.attemptId !== attemptId) return;
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
      if (state.script) task.error = `Worker requires input: ${result.question.slice(0, 1800)}`;
      if (!state.script) this.event(state, { kind: 'worker_question', taskId, summary: result.question.slice(0, 2000) });
    } else if (result.status === 'completed' && result.text?.trim() && result.text.length <= MAX_TEXT) {
      const session = state.sessions.find(item => item.sessionRef === task.sessionRef)!;
      const artifact = this.addArtifact(state, state.definition.roles[session.role]!.outputKind, result.text, task);
      task.resultRefs.push(artifact.ref);
      task.status = 'result_ready';
      if (!state.script) this.event(state, { kind: 'task_result_ready', taskId, artifactRef: artifact.ref, summary: 'Final text ready for main-agent review; verification not run.' });
    } else {
      task.status = 'failed';
      task.error = result.error ?? 'Worker did not produce a bounded final answer with a normal terminal result';
      if (!state.script) this.event(state, { kind: 'task_failed', taskId, summary: task.error.slice(0, 2000) });
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
