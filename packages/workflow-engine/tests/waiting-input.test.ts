import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';

// A member turn that ends with a question used to leave a task in
// `waiting_input` that nothing owned: no wake-up, no cancellation on pause or
// restart, and no archive. These tests pin the exits. A script-owned task keeps
// its old contract (the script sees the question as a null result), which
// script-kernel.test.ts pins separately.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function harness(path = ':memory:', now = Date.now) {
  let root: WorkflowRoot = { scopeId: 'topic-1', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root-generation-1', modelSettings: {} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishes: Array<(result: WorkflowWorkerResult) => void> = [];
  const wakeMain = vi.fn(async () => {});
  const kernel = new WorkflowKernel(path, {
    resolveRoot: async (scope: string) => scope === root.scopeId ? root : undefined,
    wakeMain,
    execute: async request => {
      requests.push(request); request.onRun('run-' + requests.length); request.onSession('thread-' + requests.length);
      return new Promise<WorkflowWorkerResult>(resolve => {
        finishes.push(resolve);
        request.signal.addEventListener('abort', () => resolve({ status: 'completed', text: 'late cancelled answer' }), { once: true });
      });
    },
  }, now);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await kernel.close(); } };
  cleanups.push(close);
  const state = () => kernel.state('topic-1')!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: 'topic-1', allowStart: true }, method,
    { operationId: randomUUID(), expectedStateVersion: state()?.stateVersion, ...(method === 'run_script' ? { plan: 'Coordinate the member and use its answer.' } : {}), ...args });
  return { kernel, state, requests, finishes, wakeMain, call, close,
    start: async () => { await call('run_script', { goal: 'authorized review', script: 'return null;', maxConcurrent: 2 }); kernel.beginScript('topic-1', state().workflowId); },
    agent: (member: string, key = member + '-init') => kernel.scriptAgent('topic-1', state().workflowId, state().script!.runId, { member, key, prompt: 'work for ' + member }),
    ask: async (question: string) => {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      finishes[0]!({ status: 'completed', question });
      await vi.waitFor(() => expect(state().tasks[0]?.status).toBe('waiting_input'));
    },
  };
}

describe('a member waiting for input', () => {
  it('raises a notice that names the question and wakes the main agent', async () => {
    const h = harness();
    await h.start(); await h.agent('asker'); await h.kernel.tick();
    await h.ask('Which branch should I target?');

    const task = h.state().tasks[0]!;
    expect(task.agentId).toBeDefined();
    expect(task.status).toBe('waiting_input');
    expect(task.error).toContain('Which branch should I target?');
    expect(h.state().events).toMatchObject([{ kind: 'worker_input_required', taskId: task.taskId, acknowledged: false }]);
    expect(h.state().events[0]!.summary).toContain('Which branch should I target?');
    expect(h.state().events[0]!.summary).toContain('asker');

    await h.kernel.tick();
    await vi.waitFor(() => expect(h.wakeMain).toHaveBeenCalledWith('topic-1'));
  });

  it('is cancelled when the workflow pauses', async () => {
    const h = harness();
    await h.start(); await h.agent('asker'); await h.kernel.tick();
    await h.ask('Need a decision');
    await h.call('pause');
    expect(h.state().tasks[0]!.status).toBe('cancelled');
    // The notice stays for the main agent: the question is why the member stopped.
    expect(h.state().events).toMatchObject([{ kind: 'worker_input_required' }]);
  });

  it('is cancelled when the root binding is invalidated', async () => {
    const h = harness();
    await h.start(); await h.agent('asker'); await h.kernel.tick();
    await h.ask('Need a decision');
    await h.call('ack_events', { eventIds: h.state().events.map(event => event.id) });
    h.kernel.invalidate('topic-1');
    expect(h.state().status).toBe('binding_attention');
    expect(h.state().tasks[0]!.status).toBe('cancelled');
  });

  it('is interrupted by a restart instead of staying in the state forever', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-input-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const path = join(dir, 'state.db');
    let now = 1000;
    const first = harness(path, () => now);
    await first.start(); await first.agent('asker'); await first.kernel.tick();
    await first.ask('Need a decision');
    await first.close();

    const recovered = harness(path, () => now);
    expect(recovered.state().tasks[0]!.status).toBe('interrupted');
    expect(recovered.state().tasks[0]!.error).toContain('Bridge restarted');
    // Nothing is left that could be resumed by a later tick.
    await recovered.kernel.tick();
    expect(recovered.state().tasks[0]!.status).toBe('interrupted');
  });
});
