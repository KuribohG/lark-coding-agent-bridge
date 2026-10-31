import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { WorkflowKernel } from '../../src/workflows/kernel';
import type { WorkflowRoot, WorkflowState, WorkflowWorkerRequest, WorkflowWorkerResult } from '../../src/workflows/types';

export const childInput = { operationId: 'child', key: 'child', goal: 'Return 42', script: 'return 42;',
  plan: 'Return 42 without native workers', checkpoint: { next: 'consume child result' } };
export const itemInput = { key: 'item', title: 'Compute the answer', input: 7 };

export function crashHarness(path: string) {
  const root: WorkflowRoot = { scopeId: 'crash-test', profile: 'default', agentKind: 'codex',
    cwdRealpath: '/workspace', policyFingerprint: 'test-policy', catalogBinding: 'test-root', modelSettings: {} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishers = new Map<string, (result: WorkflowWorkerResult) => void>();
  const kernel = new WorkflowKernel(path, {
    resolveRoot: async () => root, wakeMain: async () => {},
    execute: async request => {
      requests.push(request);
      request.onRun('run-' + request.attemptId);
      request.onSession(request.session.nativeSessionId ?? 'native-' + request.session.sessionRef);
      return new Promise<WorkflowWorkerResult>(resolve => {
        finishers.set(request.attemptId, resolve);
        request.signal.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true });
      });
    },
  });
  const state = (id?: string) => kernel.state(root.scopeId, id)!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call(
    { kind: 'main', scopeId: root.scopeId, allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args });
  const send = (request: Pick<WorkflowWorkerRequest, 'workflow' | 'task' | 'attemptId'>, method: string,
    args: Record<string, unknown> = {}) => kernel.call({ kind: 'worker', scopeId: root.scopeId,
    workflowId: request.workflow.workflowId, taskId: request.task.taskId, attemptId: request.attemptId }, method,
  { operationId: randomUUID(), ...args });
  const begin = (id = state().workflowId) => kernel.beginScript(root.scopeId, id);
  const agent = (queue = false) => kernel.scriptAgent(root.scopeId, state().workflowId, state().script!.runId,
    { key: 'worker', prompt: 'Perform the authorized test', ...(queue ? { member: 'consumer' } : { workflowTool: true }) });
  const work = (kind: string, args: Record<string, unknown> = {}) => kernel.scriptWork(root.scopeId,
    state().workflowId, state().script!.runId, { kind, ...args });
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error('Controller fixture did not settle');
      await delay(10);
    }
  };
  return { kernel, state, call, send, begin, agent, work, requests,
    start: async () => { await call('run_script', { goal: 'Crash recovery test', plan: 'Exercise an isolated controller',
      script: 'return null;', maxConcurrent: 1, timeoutMs: 600_000 }); begin(); },
    run: async (count: number) => { await kernel.tick(); await until(() => requests.length === count); },
    finish: async (request: WorkflowWorkerRequest) => {
      finishers.get(request.attemptId)!({ status: 'completed', text: 'done' });
      await until(() => !['running', 'starting', 'cancelling'].includes(
        state(request.workflow.workflowId).tasks.find(task => task.taskId === request.task.taskId)!.status));
    },
    finishScript: (id: string, text = '42') => kernel.finishScript(root.scopeId, id, state(id).script!.runId, { text }),
    replay: async () => { await call('replay_script'); begin(); },
  };
}

// Only the process test's explicitly spawned controller takes this path. It has no
// signal handlers or finally/close path; the parent kills it at a durable barrier.
if (process.argv[2] === '--workflow-crash-child') {
  const [directory, boundary] = process.argv.slice(3) as [string, string];
  const h = crashHarness(join(directory, 'state.sqlite'));
  await h.start();
  const queue = boundary.startsWith('work-');
  if (queue) await h.work('enqueue', itemInput);
  await h.agent(queue); await h.run(1);
  const request = h.requests[0]!;
  let childId: string | undefined;
  const barrier = () => {
    const db = (h.kernel as unknown as { db: Database.Database }).db;
    writeFileSync(join(directory, 'barrier.json'), JSON.stringify({ pid: process.pid, boundary,
      inTransaction: db.inTransaction, root: h.state(), child: childId ? h.state(childId) : undefined,
      request: { workflow: request.workflow, task: request.task, attemptId: request.attemptId } }));
    // A synchronous barrier also lets SIGKILL land inside SQLite transactions.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('Crash barrier unexpectedly resumed');
  };
  if (queue) {
    const grant = await h.send(request, 'claim_work', { leaseMs: 120_000 }) as { claimId: string; generation: number };
    const token = { claimId: grant.claimId, generation: grant.generation };
    await h.send(request, 'checkpoint_work', { ...token, expectedProgressVersion: 0, state: { next: 'publish', partial: 49 } });
    if (boundary === 'work-completed') await h.send(request, 'complete_work', { ...token, result: 49 });
  } else {
    if (boundary === 'child-insert-uncommitted') h.kernel.onChange('crash-test', () => {
      const db = (h.kernel as unknown as { db: Database.Database }).db;
      const row = db.prepare('SELECT id FROM workflows WHERE id != ?').get(h.state().workflowId) as { id: string } | undefined;
      if (row) { childId = row.id; barrier(); }
    });
    childId = (await h.send(request, 'run_workflow', childInput) as { workflowId: string }).workflowId;
    if (boundary !== 'before-yield') {
      await h.finish(request); h.begin(childId);
      if (boundary === 'child-finish-uncommitted') h.kernel.onChange('crash-test', () => {
        if (h.state(childId).status === 'completed') barrier();
      });
      h.finishScript(childId);
    }
  }
  barrier();
}

export interface CrashBarrier {
  pid: number;
  boundary: string;
  inTransaction: boolean;
  root: WorkflowState;
  child?: WorkflowState;
  request: Pick<WorkflowWorkerRequest, 'workflow' | 'task' | 'attemptId'>;
}
