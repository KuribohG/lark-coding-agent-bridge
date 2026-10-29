import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { sessionIdFieldForAgent } from '../agent/backend-spec';
import { log } from '../core/logger';
import { workflowDefinition, workflowDigest } from './definitions';
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
      : '当前没有绑定工作流。用户明确要求架构设计多 agent 协作时，可调用 workflow start，pluginId 为 architecture-review。';
  }

  private summary(state: WorkflowState): unknown {
    return {
      workflowId: state.workflowId, plugin: { id: state.definition.id, version: state.definition.version, digest: state.definitionDigest },
      stateVersion: state.stateVersion, status: state.status, goalRef: state.artifacts[0]?.ref,
      goalPreview: state.goal.slice(0, 500), revisionRound: state.revisionRound,
      deadlineAt: state.deadlineAt, root: state.root,
      sessions: state.sessions,
      tasks: state.tasks.map(({ taskId, taskKey, sessionRef, status, resultRefs, error, inputs, attempts }) =>
        ({ taskId, taskKey, sessionRef, status, resultRefs, error, inputs: inputs.map(({ inputId, receipt }) => ({ inputId, receipt })), attempts })),
      artifacts: state.artifacts.map(({ text: _text, ...artifact }) => artifact),
      events: state.events.filter(event => !event.acknowledged),
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
    const committed = this.db.prepare('SELECT digest, response FROM workflow_operations WHERE scope = ? AND id = ?')
      .get(scope, operationId) as { digest: string; response: string } | undefined;
    if (committed) {
      if (committed.digest !== digest) throw new Error('operationId conflict: same ID with different content');
      return JSON.parse(committed.response);
    }
    // The root may have changed while awaiting authorization.
    state = this.state(scope, optionalText(args.workflowId));
    if (method === 'start') {
      if (state || this.state(scope)) throw new Error('Root already has a workflow; cancel or complete it first');
      const definition = workflowDefinition(requiredText(args.pluginId, 100));
      const goal = requiredText(args.goal);
      state = {
        workflowId: randomUUID(), root, definition, definitionDigest: workflowDigest(definition), goal,
        stateVersion: 0, revisionRound: 0, status: 'active', createdAt: this.now(),
        deadlineAt: this.now() + definition.maxWallTimeMinutes * 60_000,
        sessions: [], tasks: [], artifacts: [], events: [],
      };
      this.addArtifact(state, 'requirements', goal);
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
    if (!['active', 'paused'].includes(state.status)) throw new Error(`Workflow is ${state.status}; P0 requires explicit cancel and a new workflow`);
    if (this.now() >= state.deadlineAt && !['ack_events', 'complete', 'cancel_task'].includes(method)) throw new Error('Workflow deadline reached');
    let response: unknown;
    switch (method) {
      case 'delegate': {
        if (state.status !== 'active') throw new Error('Workflow is paused');
        const taskKey = requiredText(args.taskKey, 200);
        const requestDigest = workflowDigest({ role: args.role, actorKey: args.actorKey, objective: args.objective, inputRefs: args.inputRefs });
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
        state.sessions.push({ sessionRef, actorId, actorKey, role, generation: 1, nativeIdKind: sessionIdFieldForAgent(root.agentKind) });
        const task: WorkflowTask = { taskId: randomUUID(), taskKey, requestDigest, sessionRef,
          objective: requiredText(args.objective), inputRefs, status: 'queued', attempts: [], inputs: [], resultRefs: [] };
        state.tasks.push(task);
        response = { taskId: task.taskId, actorId, sessionRef, status: 'queued' };
        break;
      }
      case 'send': {
        if (state.status !== 'active') throw new Error('Workflow is paused');
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
      case 'pause': state.status = 'paused'; break;
      case 'resume': state.status = 'active'; break;
      case 'complete': {
        if (state.tasks.some(task => BUSY.has(task.status))) throw new Error('Workers are still active');
        if (state.events.some(event => !event.acknowledged)) throw new Error('Acknowledge pending events before completion');
        const report = this.artifact(state, requiredText(args.reportRef));
        if (report.kind !== 'architecture-decision') throw new Error('Completion requires an architecture-decision artifact');
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
      const prompt = [role.instructions, '只做文本分析。不要修改项目、执行共享测试、发送飞书消息或再委派子 agent。结果以最终答复返回主 agent。',
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
    task.attempts.at(-1)!.endedAt = this.now();
    task.attempts.at(-1)!.result = result.status;
    if (signal.aborted || task.status === 'cancelling' || state.status === 'cancelled' || state.status === 'binding_attention') {
      task.status = 'cancelled';
    } else if (result.question) {
      task.status = 'waiting_input';
      this.event(state, { kind: 'worker_question', taskId, summary: result.question.slice(0, 2000) });
    } else if (result.status === 'completed' && result.text?.trim() && result.text.length <= MAX_TEXT) {
      const session = state.sessions.find(item => item.sessionRef === task.sessionRef)!;
      const artifact = this.addArtifact(state, state.definition.roles[session.role]!.outputKind, result.text, task);
      task.resultRefs.push(artifact.ref);
      task.status = 'result_ready';
      this.event(state, { kind: 'task_result_ready', taskId, artifactRef: artifact.ref, summary: 'Final text ready for main-agent review; verification not run.' });
    } else {
      task.status = 'failed';
      task.error = result.error ?? 'Worker did not produce a bounded final answer with a normal terminal result';
      this.event(state, { kind: 'task_failed', taskId, summary: task.error.slice(0, 2000) });
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
