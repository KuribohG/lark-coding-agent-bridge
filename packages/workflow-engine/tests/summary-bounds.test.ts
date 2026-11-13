import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Summary = { stateVersion: number; taskCounts: Record<string, number>; omitted?: Record<string, number>;
  tasks: Array<{ scriptKey: string; status: string }>; artifacts: unknown[] };
type Page = { total: number; offset: number; nextOffset: number | null; items: Array<{ scriptKey: string }> };

async function harness(tasks: number) {
  const root: WorkflowRoot = { scopeId: 'summary-test', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishers = new Map<string, (result: WorkflowWorkerResult) => void>();
  const host = { resolveRoot: async () => root, wakeMain: async () => {},
    execute: async (request: WorkflowWorkerRequest) => {
      requests.push(request);
      request.onRun('run-' + request.attemptId);
      request.onSession('native-' + request.session.actorId);
      return new Promise<WorkflowWorkerResult>(resolve => {
        finishers.set(request.attemptId, resolve);
        request.signal.addEventListener('abort', () => resolve({ status: 'completed', text: 'aborted' }), { once: true });
      });
    } };
  const kernel = new WorkflowKernel(':memory:', host, () => 1_000_000);
  cleanup.push(() => kernel.close());
  const state = () => kernel.state(root.scopeId)!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: root.scopeId, allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args });
  await call('run_script', { goal: 'Run many tasks', plan: 'Many one-shot workers, a few at a time.', script: 'return null;', maxAgents: tasks, maxConcurrent: 2 });
  kernel.beginScript(root.scopeId, state().workflowId);
  for (let index = 0; index < tasks; index++) {
    void kernel.scriptAgent(root.scopeId, state().workflowId, state().script!.runId, { key: 'task-' + index, prompt: 'Do part ' + index }).catch(() => {});
  }
  await vi.waitFor(() => expect(state().tasks).toHaveLength(tasks), { timeout: 20_000 });
  await kernel.tick();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  finishers.get(requests[0]!.attemptId)!({ status: 'completed', text: 'done' });
  await vi.waitFor(() => expect(state().tasks.filter(task => task.status === 'result_ready')).toHaveLength(1), { timeout: 10_000 });
  return { kernel, root, state, call };
}

describe('workflow summary size', () => {
  it('keeps the turn context and status bounded for a workflow with many tasks', async () => {
    const h = await harness(300);
    const full = JSON.stringify(h.state().tasks).length;
    expect(full).toBeGreaterThan(100_000);

    const summary = await h.call('status') as Summary;
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(40_000);
    expect(Object.values(summary.taskCounts).reduce((sum, count) => sum + count, 0)).toBe(300);
    expect(summary.taskCounts.result_ready).toBe(1);
    expect(summary.omitted!.tasks).toBe(300 - summary.tasks.length);
    expect(summary.tasks.length).toBeGreaterThan(0);
    // Tasks in progress are kept ahead of queued ones, and those ahead of finished ones.
    expect(summary.tasks.every(task => task.status !== 'result_ready')).toBe(true);
    expect(summary.tasks.filter(task => task.status !== 'queued').map(task => task.scriptKey)).toContain('task-1');

    const context = h.kernel.context(h.root.scopeId);
    expect(context.length).toBeLessThan(h.state().definition.mainInstructions.length + 41_000);
    expect(context).toContain('"omitted"');

    // A change returns the same bounded view.
    expect(JSON.stringify(await h.call('pause')).length).toBeLessThanOrEqual(40_000);
  }, 60_000);

  it('pages through a list the summary cut', async () => {
    const h = await harness(100);
    const keys: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page = await h.call('status', { list: 'tasks', offset, limit: 64 }) as Page;
      expect(page.total).toBe(100);
      keys.push(...page.items.map(task => task.scriptKey));
      offset = page.nextOffset;
    }
    expect(keys).toEqual(h.state().tasks.map(task => task.scriptKey));
    expect((await h.call('status', { list: 'tasks' }) as Page).items).toHaveLength(16);
    await expect(h.call('status', { list: 'nothing' })).rejects.toThrow('Unknown list; expected one of: tasks, artifacts');
    await expect(h.call('status', { list: 'tasks', limit: 65 })).rejects.toThrow('Expected an integer');
  });

  it('leaves a small workflow whole', async () => {
    const h = await harness(3);
    const summary = await h.call('status') as Summary;
    expect(summary.omitted).toBeUndefined();
    expect(summary.tasks.map(task => task.scriptKey)).toEqual(h.state().tasks.map(task => task.scriptKey));
  });
});
