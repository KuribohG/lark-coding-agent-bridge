import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const host = {
    resolveRoot: async (scope: string) => scope === root.scopeId ? root : undefined,
    wakeMain,
    execute: async (request: WorkflowWorkerRequest) => {
      requests.push(request);
      request.onRun(`run-${requests.length}`);
      request.onSession(request.session.nativeSessionId ?? `thread-${requests.length}`, 'model');
      return new Promise<WorkflowWorkerResult>(resolve => {
        finishes.push(resolve);
        request.signal.addEventListener('abort', () => resolve({ status: 'completed', text: 'late cancelled answer' }), { once: true });
      });
    },
  };
  const kernel = new WorkflowKernel(path, host);
  cleanups.push(() => kernel.close());
  const call = async (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: 'topic-1' }, method,
    { operationId: randomUUID(), expectedStateVersion: kernel.state('topic-1')?.stateVersion, ...args });
  return { kernel, host, requests, finishes, wakeMain, call,
    changeRoot: () => { root = { ...root, catalogBinding: 'replacement' }; },
    start: () => call('start', { pluginId: 'architecture-review', goal: 'linearizable failover; acknowledge only quorum writes' }),
    delegate: (key: string, role = 'designer-a', inputRefs: string[] = []) => call('delegate', { taskKey: key, actorKey: key, role, objective: `investigate ${key}`, inputRefs }),
    settle: async () => vi.waitFor(() => expect(kernel.state('topic-1')?.tasks.some(task => ['starting', 'running', 'cancelling'].includes(task.status))).toBe(false)),
  };
}

describe('agent-led workflow kernel', () => {
  it('coalesces concurrent identical start calls after asynchronous authorization', async () => {
    const h = harness();
    const args = { operationId: 'concurrent', pluginId: 'architecture-review', goal: 'one workflow' };
    const invoke = () => h.kernel.call({ kind: 'main', scopeId: 'topic-1' }, 'start', args);
    const [a, b] = await Promise.all([invoke(), invoke()]);
    expect(a).toEqual(b);
  });
  it('deduplicates operations and task keys, and rejects conflicting content', async () => {
    const h = harness();
    const args = { operationId: 'start-1', pluginId: 'architecture-review', goal: 'goal' };
    const first = await h.call('start', args);
    // Keep the exact original envelope for an idempotent replay.
    expect(await h.kernel.call({ kind: 'main', scopeId: 'topic-1' }, 'start', args)).toEqual(first);
    await expect(h.kernel.call({ kind: 'main', scopeId: 'topic-1' }, 'start', { ...args, goal: 'changed' })).rejects.toThrow('conflict');
    await h.delegate('a');
    await h.delegate('a');
    expect(h.kernel.state('topic-1')?.tasks).toHaveLength(1);
    await expect(h.call('delegate', { taskKey: 'a', actorKey: 'a', role: 'designer-a', objective: 'different' })).rejects.toThrow('taskKey conflict');
  });

  it('caps workers, keeps designers independent, and resumes their original native session', async () => {
    const h = harness(); await h.start();
    await h.delegate('a'); await h.delegate('b', 'designer-b'); await h.delegate('review', 'challenger');
    await h.kernel.tick();
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    expect(h.requests[0]?.session.nativeSessionId).toBeUndefined();
    expect(h.requests[1]?.session.nativeSessionId).toBeUndefined();
    expect(h.requests[1]?.prompt).not.toContain('investigate a');
    await expect(h.call('send', { taskId: h.requests[0]!.task.taskId, inputId: 'busy', text: 'more' })).rejects.toThrow('busy');
    h.finishes[0]!({ status: 'completed', text: 'proposal A' });
    h.finishes[1]!({ status: 'completed', text: 'proposal B' });
    await h.settle();
    const state = h.kernel.state('topic-1')!;
    expect(state.sessions.map(session => session.nativeSessionId)).toEqual(['thread-1', 'thread-2', undefined]);
    const task = state.tasks[0]!;
    await expect(h.delegate('leak', 'designer-b', task.resultRefs)).rejects.toThrow('Independent designers');
    await h.call('send', { taskId: task.taskId, inputId: 'follow-up', text: 'explain fencing' });
    await h.kernel.tick();
    await vi.waitFor(() => expect(h.requests).toHaveLength(4));
    const resumed = h.requests.find(request => request.task.taskId === task.taskId && request.session.nativeSessionId);
    expect(resumed?.session.nativeSessionId).toBe('thread-1');
    expect(resumed?.prompt).toContain('explain fencing');
    expect(h.wakeMain).toHaveBeenCalledWith('topic-1');
  });

  it('rejects cross-scope reads and worker privilege escalation or artifact leakage', async () => {
    const h = harness(); await h.start(); await h.delegate('a'); await h.delegate('b', 'designer-b');
    await h.kernel.tick(); await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    const state = h.kernel.state('topic-1')!;
    await expect(h.kernel.call({ kind: 'main', scopeId: 'topic-2' }, 'read_artifact',
      { workflowId: state.workflowId, ref: state.artifacts[0]!.ref })).rejects.toThrow('not found');
    const request = h.requests[0]!;
    const caller = { kind: 'worker' as const, scopeId: 'topic-1', workflowId: state.workflowId,
      taskId: request.task.taskId, attemptId: request.attemptId };
    await expect(h.kernel.call(caller, 'delegate', {})).rejects.toThrow('not permitted');
    await expect(h.kernel.call(caller, 'read_artifact', { ref: state.artifacts[0]!.ref })).rejects.toThrow('outside worker');
    expect(await h.kernel.call(caller, 'read_context', {})).toMatchObject({ objective: 'investigate a' });
    h.kernel.cancel('topic-1');
    await expect(h.kernel.call(caller, 'task_status', {})).rejects.toThrow('inactive');
  });

  it('does not accept a late result after stop, or dispatch queued work', async () => {
    const h = harness(); await h.start(); await h.delegate('a'); await h.delegate('b'); await h.delegate('c');
    await h.kernel.tick(); await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    const workflowId = h.kernel.state('topic-1')!.workflowId;
    expect(h.kernel.cancel('topic-1')).toBe(true);
    await vi.waitFor(() => expect(h.kernel.state('topic-1', workflowId)!.tasks.every(task => task.status === 'cancelled')).toBe(true));
    await h.kernel.tick();
    expect(h.requests).toHaveLength(2);
    expect(h.kernel.state('topic-1', workflowId)!.artifacts).toHaveLength(1);
  });

  it('invalidates a replaced root and keeps its events away from the new root', async () => {
    const h = harness(); await h.start(); await h.delegate('a');
    await h.kernel.tick(); await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.changeRoot(); await h.kernel.tick(); await h.settle();
    expect(h.kernel.state('topic-1')?.status).toBe('binding_attention');
    expect(h.kernel.hasWake('topic-1')).toBe(false);
    expect(h.wakeMain).not.toHaveBeenCalled();
  });

  it('keeps progress-only and failed output out of result-ready artifacts', async () => {
    const h = harness(); await h.start(); await h.delegate('a'); await h.delegate('b');
    await h.kernel.tick(); await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    h.finishes[0]!({ status: 'completed' });
    h.finishes[1]!({ status: 'failed', text: 'partial draft' });
    await h.settle();
    expect(h.kernel.state('topic-1')!.tasks.map(task => task.status)).toEqual(['failed', 'failed']);
    expect(h.kernel.state('topic-1')!.artifacts).toHaveLength(1);
  });

  it('distinguishes event notification from acknowledgement and gates completion', async () => {
    const h = harness(); await h.start(); await h.delegate('a');
    await h.kernel.tick(); await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.finishes[0]!({ status: 'completed', text: 'proposal' }); await h.settle();
    const ids = h.kernel.state('topic-1')!.events.map(event => event.id);
    h.kernel.markNotified('topic-1', ids);
    expect(h.kernel.hasWake('topic-1')).toBe(false);
    expect(h.kernel.context('topic-1')).toContain(ids[0]);
    const report = await h.call('publish_artifact', { kind: 'architecture-decision', text: 'Inconclusive; requires model checking.' }) as { ref: string };
    await expect(h.call('complete', { reportRef: report.ref, openIssues: [], verificationLimits: 'not run' })).rejects.toThrow('Acknowledge');
    await h.call('ack_events', { eventIds: ids });
    await h.call('complete', { reportRef: report.ref, openIssues: ['unverified safety'], verificationLimits: 'not run' });
    expect(h.kernel.state('topic-1')).toBeUndefined();
  });

  it('enforces pause, state versions, and a two-round revision budget', async () => {
    const h = harness(); await h.start(); await h.delegate('a');
    await h.call('pause'); await h.kernel.tick(); expect(h.requests).toHaveLength(0);
    await expect(h.call('delegate', { taskKey: 'b' })).rejects.toThrow('paused');
    await expect(h.call('resume', { expectedStateVersion: 0 })).rejects.toThrow('stateVersion');
    await h.call('resume'); await h.call('begin_revision_round'); await h.call('begin_revision_round');
    await expect(h.call('begin_revision_round')).rejects.toThrow('limit');
  });

  it('preserves identities and artifacts on restart without automatically rerunning work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-restart-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'workflow.sqlite');
    const h = harness(path); await h.start(); await h.delegate('a');
    await h.kernel.tick(); await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.finishes[0]!({ status: 'completed', text: 'durable answer' }); await h.settle();
    await h.kernel.close(); cleanups.pop();
    const recovered = harness(path);
    expect(recovered.kernel.state('topic-1')?.status).toBe('interrupted');
    expect(recovered.kernel.state('topic-1')?.sessions[0]?.nativeSessionId).toBe('thread-1');
    expect(recovered.kernel.state('topic-1')?.artifacts.at(-1)?.text).toBe('durable answer');
    await recovered.kernel.tick(); expect(recovered.requests).toHaveLength(0);
  });
});
