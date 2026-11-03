import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function harness(path = ':memory:', delayedStop = false) {
  let now = 1_000_000;
  const root: WorkflowRoot = { scopeId: 'events', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishers = new Map<string, (result: WorkflowWorkerResult) => void>();
  const host = { resolveRoot: async () => root, wakeMain: async () => {}, execute: async (request: WorkflowWorkerRequest) => {
    requests.push(request); request.onRun('run-' + request.attemptId);
    request.onSession(request.session.nativeSessionId ?? 'native-' + request.session.actorId);
    return new Promise<WorkflowWorkerResult>(resolve => {
      finishers.set(request.attemptId, resolve);
      if (!delayedStop) request.signal.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true });
    });
  } };
  let kernel = new WorkflowKernel(path, host, () => now);
  cleanup.push(async () => { for (const finish of finishers.values()) finish({ status: 'stopped' }); await kernel.close(); });
  const state = () => kernel.state(root.scopeId)!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: root.scopeId, allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args });
  const control = (kind: string, args: Record<string, unknown> = {}) => kernel.scriptControl(root.scopeId, state().workflowId, state().script!.runId, { kind, ...args });
  const agent = (member: string, key = member + '-init') => kernel.scriptAgent(root.scopeId, state().workflowId, state().script!.runId, { member, key, prompt: 'Authorized member work' });
  const run = async (count: number) => { await kernel.tick(); await vi.waitFor(() => expect(requests).toHaveLength(count)); };
  const finish = async (request: WorkflowWorkerRequest, result: WorkflowWorkerResult = { status: 'completed', text: 'ready' }) => {
    finishers.get(request.attemptId)!(result);
    await vi.waitFor(() => expect(['starting', 'running', 'cancelling']).not.toContain(kernel.state(root.scopeId, request.workflow.workflowId)!.tasks.find(task => task.taskId === request.task.taskId)!.status));
  };
  return { get kernel() { return kernel; }, state, call, control, agent, requests, run, finish,
    start: async () => { await call('run_script', { goal: 'Coordinate authorized work', plan: 'Wait for evidence and cancel redundant work', script: 'return null;' }); kernel.beginScript(root.scopeId, state().workflowId); },
    bootstrap: async (name: string) => { await agent(name); await run(requests.length + 1); await finish(requests.at(-1)!); },
    result: (pending: { kind: string; taskId?: string; waitId?: string }) => kernel.scriptControlResult(root.scopeId, state().workflowId, state().script!.runId, pending),
    mail: (args: Record<string, unknown>) => kernel.scriptMailbox(root.scopeId, state().workflowId, state().script!.runId, args),
    advance: (ms: number) => { now += ms; },
    restart: async () => { await kernel.close(); kernel = new WorkflowKernel(path, host, () => now); },
    replay: async () => { if (state().script!.status === 'running') await call('pause'); await call('replay_script'); kernel.beginScript(root.scopeId, state().workflowId); },
  };
}

describe('durable events and task control', () => {
  it('selects a matching message, preserves losing messages and acknowledges only the next successful turn', async () => {
    const h = harness(); await h.start(); await h.bootstrap('A'); await h.bootstrap('B');
    const pending = await h.control('wait', { key: 'evidence', any: [
      { kind: 'message', member: 'A', topic: 'evidence', correlationId: 'issue-1' },
      { kind: 'message', member: 'B', topic: 'review' },
    ] });
    await h.call('send_message', { member: 'A', text: 'unrelated', topic: 'evidence', correlationId: 'issue-2' });
    expect(h.result(pending)).toBeUndefined();
    await expect(h.agent('A', 'too-early')).rejects.toThrow('waiting for an event');
    await h.call('send_message', { member: 'B', text: 'verified', topic: 'review' });
    expect(h.result(pending)).toMatchObject({ index: 1, kind: 'message', value: [{ text: 'verified', topic: 'review' }] });
    const box = h.state().mailbox!;
    expect(box.messages.find(message => message.text === 'unrelated')!.receiptId).toBeUndefined();
    expect(box.messages.find(message => message.text === 'verified')!.consumedByTurnId).toBeUndefined();
    await h.agent('B', 'use-review'); await h.run(3); await h.finish(h.requests[2]!);
    expect(h.state().mailbox!.messages.find(message => message.text === 'verified')!.consumedByTurnId).toBeDefined();
    const other = await h.mail({ kind: 'receive', member: 'A', key: 'other', correlationId: 'issue-2' });
    expect(h.kernel.scriptMailboxResult('events', h.state().workflowId, h.state().script!.runId, other.receiptId!)).toMatchObject([{ text: 'unrelated' }]);
  });

  it('retains an absolute timer across restart and leaves a late message available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-events-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const h = harness(join(directory, 'state.db')); await h.start(); await h.bootstrap('A');
    const spec = { key: 'deadline', any: [{ kind: 'message', member: 'A' }, { kind: 'timer', afterMs: 1000 }] };
    await h.control('wait', spec); h.advance(400); await h.restart();
    await h.kernel.tick(); expect(h.requests).toHaveLength(1);
    await h.replay(); await h.agent('A'); const pending = await h.control('wait', spec);
    h.advance(599); await h.kernel.tick(); expect(h.result(pending)).toBeUndefined();
    h.advance(1); await h.kernel.tick(); expect(h.result(pending)).toEqual({ index: 1, kind: 'timer', value: { at: 1_001_000 } });
    expect(h.state().agents![0]!.wait).toBeUndefined();
    await h.call('send_message', { member: 'A', text: 'late' });
    expect(h.state().mailbox!.messages[0]!.receiptId).toBeUndefined();
    await h.replay(); await h.agent('A');
    expect(h.result(await h.control('wait', spec))).toEqual({ index: 1, kind: 'timer', value: { at: 1_001_000 } });
    await expect(h.control('wait', { key: 'changed', any: [{ kind: 'timer', afterMs: -1 }] })).rejects.toThrow('integer');
  });

  it('observes a completed work item without waiting for queue closure', async () => {
    const h = harness(); await h.start();
    const item = await h.call('enqueue_work', { key: 'work', title: 'Compute', input: 4 }) as { itemId: string };
    await h.agent('A'); await h.run(1);
    const pending = await h.control('wait', { key: 'completed', any: [{ kind: 'work', itemId: item.itemId }] });
    const worker = h.requests[0]!;
    const send = (method: string, args: Record<string, unknown> = {}) => h.kernel.call({ kind: 'worker', scopeId: 'events', workflowId: h.state().workflowId,
      taskId: worker.task.taskId, attemptId: worker.attemptId }, method, { operationId: randomUUID(), ...args });
    const grant = await send('claim_work') as { claimId: string; generation: number };
    await send('complete_work', { claimId: grant.claimId, generation: grant.generation, result: 16 });
    expect(h.result(pending)).toMatchObject({ kind: 'work', value: { status: 'completed', result: 16, generation: 1 } });
    expect(h.state().workQueue!.closedAt).toBeUndefined();
    await h.finish(worker);
  });

  it('lets an expired deadline win when a message arrives before the next scheduler tick', async () => {
    const h = harness(); await h.start(); await h.bootstrap('A');
    const wait = await h.control('wait', { key: 'deadline', any: [{ kind: 'message', member: 'A' }, { kind: 'timer', afterMs: 10 }] });
    h.advance(11);
    await h.call('send_message', { member: 'A', text: 'after deadline' });
    expect(h.result(wait)).toMatchObject({ kind: 'timer' });
    expect(h.state().mailbox!.messages[0]!.receiptId).toBeUndefined();
  });

  it('cancels a task, waits for exit, rejects its late answer and replays the same decision', async () => {
    const h = harness(':memory:', true); await h.start();
    const a = await h.control('start', { key: 'a', prompt: 'Candidate A' });
    const b = await h.control('start', { key: 'b', prompt: 'Candidate B' });
    await h.run(2);
    const spec = { key: 'winner', any: [{ kind: 'task', taskId: a.taskId }, { kind: 'task', taskId: b.taskId }] };
    const winner = await h.control('wait', spec);
    await h.finish(h.requests[0]!, { status: 'completed', text: 'good' });
    expect(h.result(winner)).toMatchObject({ index: 0, kind: 'task' });
    const stopped = await h.control('cancel', { key: 'stop-b', taskId: b.taskId });
    expect(h.requests[1]!.signal.aborted).toBe(true); expect(h.result(stopped)).toBeUndefined();
    await h.finish(h.requests[1]!, { status: 'completed', text: 'late and invalid' });
    expect(h.result(stopped)).toMatchObject({ status: 'cancelled' });
    expect(h.state().tasks[1]!.resultRefs).toEqual([]);
    await h.replay();
    expect((await h.control('start', { key: 'a', prompt: 'Candidate A' })).taskId).toBe(a.taskId);
    expect((await h.control('start', { key: 'b', prompt: 'Candidate B' })).taskId).toBe(b.taskId);
    expect(h.result(await h.control('wait', spec))).toMatchObject({ index: 0 });
    expect(h.result(await h.control('cancel', { key: 'stop-b', taskId: b.taskId }))).toMatchObject({ status: 'cancelled' });
    await h.kernel.tick(); expect(h.requests).toHaveLength(2);
  });

  it('rejects foreign handles and unfinished handles, and keeps control keys separate', async () => {
    const h = harness(); await h.start();
    await expect(h.control('join', { taskId: 'foreign' })).rejects.toThrow('not found');
    await expect(h.control('start', { key: 'named', member: 'A', prompt: 'work' })).rejects.toThrow('independent');
    await h.call('enqueue_work', { key: 'item', title: 'work' });
    await expect(h.control('wait', { key: 'item', any: [{ kind: 'timer', afterMs: 0 }] })).rejects.toThrow('another operation');
    const task = await h.control('start', { key: 'handle', prompt: 'work' }); await h.run(1);
    h.kernel.finishScript('events', h.state().workflowId, h.state().script!.runId, { text: 'null' });
    expect(h.state().script!.status).toBe('failed'); expect(h.requests[0]!.signal.aborted).toBe(true);
    expect(task.taskId).toBeDefined();
  });

  it('cancels a managed parent and waits for its child worker to exit', async () => {
    const h = harness(':memory:', true); await h.start();
    const parent = await h.control('start', { key: 'parent', prompt: 'Delegate one check', workflowTool: true });
    await h.run(1); const request = h.requests[0]!;
    const child = await h.kernel.call({ kind: 'worker', scopeId: 'events', workflowId: h.state().workflowId,
      taskId: request.task.taskId, attemptId: request.attemptId }, 'run_workflow', { operationId: 'child', key: 'child', goal: 'Check', plan: 'One child check', script: 'return null;' }) as { workflowId: string };
    await h.finish(request);
    h.kernel.beginScript('events', child.workflowId);
    const childState = h.kernel.state('events', child.workflowId)!;
    await h.kernel.scriptAgent('events', child.workflowId, childState.script!.runId, { key: 'leaf', prompt: 'Check' });
    await h.run(2);
    const stop = await h.control('cancel', { key: 'stop-parent', taskId: parent.taskId });
    expect(h.requests[1]!.signal.aborted).toBe(true);
    expect(h.result(stop)).toBeUndefined();
    await h.finish(h.requests[1]!);
    expect(h.result(stop)).toMatchObject({ status: 'cancelled' });
    expect(h.kernel.state('events', child.workflowId)!.status).toBe('cancelled');
  });

  it('recovers a persisted cancellation intent without launching that task again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-cancel-recovery-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    const h = harness(path, true); await h.start();
    const task = await h.control('start', { key: 'task', prompt: 'Work' }); await h.run(1);
    await h.control('cancel', { key: 'stop', taskId: task.taskId });
    const persistedDuringCancellation = h.state();
    expect(persistedDuringCancellation.tasks[0]!.status).toBe('cancelling');
    await h.finish(h.requests[0]!); await h.kernel.close();
    const db = new Database(path);
    try { db.prepare('UPDATE workflows SET data=? WHERE id=?').run(JSON.stringify(persistedDuringCancellation), persistedDuringCancellation.workflowId); }
    finally { db.close(); }
    await h.restart(); await h.replay();
    const restored = await h.control('start', { key: 'task', prompt: 'Work' });
    expect(restored.taskId).toBe(task.taskId);
    expect(h.result(await h.control('cancel', { key: 'stop', taskId: restored.taskId }))).toMatchObject({ status: 'cancelled' });
    await h.kernel.tick(); expect(h.requests).toHaveLength(1);
  });
});
