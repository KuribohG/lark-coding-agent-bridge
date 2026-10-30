import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../../../src/workflows/kernel';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../../../src/workflows/types';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function harness(path = ':memory:') {
  let root: WorkflowRoot = { scopeId: 'topic-1', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root-generation-1', modelSettings: {} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishes: Array<(result: WorkflowWorkerResult) => void> = [];
  const wakeMain = vi.fn(async () => {});
  const kernel = new WorkflowKernel(path, {
    resolveRoot: async scope => scope === root.scopeId ? root : undefined, wakeMain,
    execute: async request => {
      requests.push(request); request.onRun('run-' + requests.length); request.onSession('thread-' + requests.length);
      return new Promise<WorkflowWorkerResult>(resolve => {
        finishes.push(resolve);
        request.signal.addEventListener('abort', () => resolve({ status: 'completed', text: 'late cancelled answer' }), { once: true });
      });
    },
  });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await kernel.close(); } };
  cleanups.push(close);
  const state = () => kernel.state('topic-1')!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: 'topic-1', allowStart: true }, method,
    { operationId: randomUUID(), expectedStateVersion: state()?.stateVersion, ...(method === 'run_script' || method === 'replay_script' ? {plan:'Review the task with the requested harness and model; return a final result.'} : {}), ...args });
  return { kernel, state, requests, finishes, wakeMain, call, close,
    changeRoot: () => { root = { ...root, catalogBinding: 'replacement' }; },
    start: async () => { await call('run_script', { goal: 'authorized review', script: 'return null;', maxConcurrent: 2 }); kernel.beginScript('topic-1', state().workflowId); },
    agent: (key: string) => kernel.scriptAgent('topic-1', state().workflowId, state().script!.runId, { key, prompt: 'investigate ' + key }),
    settle: async () => vi.waitFor(() => expect(state().tasks.some(t => ['starting', 'running', 'cancelling'].includes(t.status))).toBe(false)),
    finish: () => kernel.finishScript('topic-1', state().workflowId, state().script!.runId, { text: '"report"' }),
  };
}

describe('workflow kernel contracts', () => {
  it('requires caller start permission even when request parameters claim authorization', async () => {
    const h = harness();
    const args = { operationId: 'start', goal: '/workflow start task', plan: 'Return one.', script: 'return 1;', allowStart: true };
    await expect(h.kernel.call({ kind: 'main', scopeId: 'topic-1' }, 'run_script', args)).rejects.toThrow('explicit /workflow');
    expect(h.state()).toBeUndefined();
    expect(h.requests).toHaveLength(0);
  });

  it('coalesces concurrent identical starts after asynchronous authorization', async () => {
    const h = harness(); const args = { operationId: 'concurrent', goal: 'one workflow', plan:'Return one.', script: 'return 1;' };
    const invoke = () => h.kernel.call({ kind: 'main', scopeId: 'topic-1', allowStart: true }, 'run_script', args);
    const [a, b] = await Promise.all([invoke(), invoke()]); expect(a).toEqual(b);
  });
  it('deduplicates operation IDs and rejects changed content', async () => {
    const h = harness(); const args = { operationId: 'start-1', goal: 'goal', plan:'Return null.', script: 'return null;' };
    const first = await h.kernel.call({ kind: 'main', scopeId: 'topic-1', allowStart: true }, 'run_script', args);
    expect(await h.kernel.call({ kind: 'main', scopeId: 'topic-1', allowStart: true }, 'run_script', args)).toEqual(first);
    await expect(h.kernel.call({ kind: 'main', scopeId: 'topic-1', allowStart: true }, 'run_script', { ...args, goal: 'changed' })).rejects.toThrow('conflict');
  });
  it.each(['start', 'delegate', 'send', 'begin_revision_round'])('rejects removed operation %s', async method => {
    const h = harness(); await expect(h.call(method)).rejects.toThrow('Unsupported workflow operation');
    expect(h.state()).toBeUndefined();
  });
  it('rejects cross-scope reads and worker privilege escalation', async () => {
    const h = harness(); await h.start(); await h.agent('a'); await h.kernel.tick();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const state = h.state(); const request = h.requests[0]!;
    await expect(h.kernel.call({ kind: 'main', scopeId: 'topic-2' }, 'read_artifact',
      { workflowId: state.workflowId, ref: state.artifacts[0]!.ref })).rejects.toThrow('not found');
    const caller = { kind: 'worker' as const, scopeId: 'topic-1', workflowId: state.workflowId,
      taskId: request.task.taskId, attemptId: request.attemptId };
    await expect(h.kernel.call(caller, 'run_script', {})).rejects.toThrow('not permitted');
    await expect(h.kernel.call(caller, 'read_artifact', { ref: state.artifacts[0]!.ref })).rejects.toThrow('outside worker');
    expect(await h.kernel.call(caller, 'read_context', {})).toMatchObject({ objective: 'investigate a' });
    h.kernel.cancel('topic-1'); await expect(h.kernel.call(caller, 'task_status', {})).rejects.toThrow('inactive');
  });
  it('invalidates a replaced root and keeps events away from the new root', async () => {
    const h = harness(); await h.start(); await h.agent('a'); await h.kernel.tick();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1)); h.changeRoot(); await h.kernel.tick(); await h.settle();
    expect(h.state().status).toBe('binding_attention'); expect(h.kernel.hasWake('topic-1')).toBe(false); expect(h.wakeMain).not.toHaveBeenCalled();
  });
  it('keeps missing and failed final answers out of artifacts', async () => {
    const h = harness(); await h.start(); await h.agent('a'); await h.agent('b'); await h.kernel.tick();
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    h.finishes[0]!({ status: 'completed' }); h.finishes[1]!({ status: 'failed', text: 'partial draft' }); await h.settle();
    expect(h.state().tasks.map(task => task.status)).toEqual(['failed', 'failed']);
    expect(h.state().artifacts.filter(a => a.taskId)).toHaveLength(0);
  });
  it('distinguishes notification from acknowledgement and gates completion on a report', async () => {
    const h = harness(); await h.start(); h.finish();
    const ids = h.state().events.map(event => event.id); h.kernel.markNotified('topic-1', ids);
    expect(h.kernel.hasWake('topic-1')).toBe(false); expect(h.kernel.context('topic-1')).toContain(ids[0]);
    const report = await h.call('publish_artifact', { kind: 'report', text: 'Inconclusive; requires model checking.' }) as { ref: string };
    await expect(h.call('complete', { reportRef: report.ref, openIssues: [], verificationLimits: 'not run' })).rejects.toThrow('Acknowledge');
    await h.call('ack_events', { eventIds: ids });
    await h.call('complete', { reportRef: report.ref, openIssues: ['unverified safety'], verificationLimits: 'not run' });
    expect(h.state()).toBeUndefined();
  });
  it('retires persisted legacy workflows and frees the scope while retaining readable artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-retirement-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'workflow.sqlite'); const h = harness(path); await h.start(); await h.agent('a');
    const legacy = h.state(); const oldId = legacy.workflowId; const ref = legacy.artifacts[0]!.ref;
    await h.close();
    const { script: _script, ...old } = legacy;
    const db = new Database(path);
    db.prepare('UPDATE workflows SET data=? WHERE id=?').run(JSON.stringify({ ...old, definition: { ...old.definition, id: 'architecture-review', kind: 'agent-led' } }), oldId);
    db.close();
    const recovered = harness(path);
    expect(recovered.state()).toBeUndefined();
    expect(recovered.kernel.state('topic-1', oldId)).toMatchObject({ status: 'cancelled', tasks: [{ status: 'cancelled' }] });
    expect(await recovered.call('read_artifact', { workflowId: oldId, ref })).toMatchObject({ text: 'authorized review' });
    await expect(recovered.call('replay_script', { workflowId: oldId })).rejects.toThrow('retired');
    await recovered.start(); expect(recovered.state().workflowId).not.toBe(oldId);
    expect(recovered.kernel.context('topic-1')).not.toContain('architecture-review');
  });
});
