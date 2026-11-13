import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_AFTER_MS } from '../src/engine/archive';
import { WorkflowKernel } from '../src/engine/kernel';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Summary = { taskCounts: Record<string, number>; tasks: unknown[] };

function harness(path = ':memory:') {
  const root: WorkflowRoot = { scopeId: 'archive-test', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
  const clock = { now: 1_000_000 };
  const requests: WorkflowWorkerRequest[] = [];
  const host = { resolveRoot: async () => root, wakeMain: async () => {},
    execute: async (request: WorkflowWorkerRequest): Promise<WorkflowWorkerResult> => {
      requests.push(request);
      request.onRun('run-' + request.attemptId);
      request.onSession('native-' + request.session.actorId);
      return { status: 'completed', text: 'answer to ' + request.task.objective };
    } };
  const kernel = new WorkflowKernel(path, host, () => clock.now);
  cleanup.push(() => kernel.close());
  const state = () => kernel.state(root.scopeId)!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: root.scopeId, allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args });
  const start = async (maxAgents: number) => {
    await call('run_script', { goal: 'Run many tasks', plan: 'Many one-shot workers.', script: 'return null;', maxAgents, maxConcurrent: 256 });
    kernel.beginScript(root.scopeId, state().workflowId);
  };
  const agent = (input: Record<string, unknown>) => kernel.scriptAgent(root.scopeId, state().workflowId, state().script!.runId, input);
  const result = (taskId: string) => kernel.scriptTaskResult(root.scopeId, state().workflowId, state().script!.runId, taskId);
  /** Runs the given calls to completion and returns their task IDs. */
  const run = async (inputs: Array<Record<string, unknown>>) => {
    const ids = (await Promise.all(inputs.map(agent))).map(item => item.taskId);
    // Each pass admits as many queued tasks as the workflow may run at once.
    await vi.waitFor(async () => { await kernel.tick(); for (const id of ids) expect(result(id)).toBeDefined(); }, { timeout: 20_000 });
    return ids;
  };
  /** Lets every finished task age past the archive window and gives the scheduler a pass over the workflow. */
  const age = async () => { clock.now += ARCHIVE_AFTER_MS + 60_000; await kernel.tick(); };
  return { kernel, root, clock, requests, state, call, start, agent, result, run, age };
}

const batch = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ key: 'task-' + (from + index), prompt: 'part ' + (from + index) }));

describe('archiving finished tasks', () => {
  it('runs more tasks than the state ever holds and keeps totals, results and keys', async () => {
    const verify = process.env.WORKFLOW_ENGINE_VERIFY;
    // Replaying the whole journal after every commit is quadratic in a run this long; the smaller cases below keep it on.
    process.env.WORKFLOW_ENGINE_VERIFY = '0';
    cleanup.push(() => { process.env.WORKFLOW_ENGINE_VERIFY = verify; });
    const h = harness();
    await h.start(10_000);
    const total = 2600;
    let first = '';
    let held = 0;
    for (let from = 0; from < total; from += 200) {
      const ids = await h.run(batch(from, 200));
      first ||= ids[0]!;
      await h.age();
      held = Math.max(held, h.state().tasks.length);
    }
    expect(held).toBeLessThanOrEqual(200);
    const state = h.state();
    expect(state.tasks).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
    expect(state.script!.calls).toHaveLength(0);
    expect(state.archived).toEqual({ tasks: total, attempts: total, statuses: { result_ready: total } });
    expect(state.artifacts.every(artifact => !artifact.taskId)).toBe(true);
    expect(h.requests).toHaveLength(total);

    const summary = await h.call('status') as Summary;
    expect(summary.taskCounts).toEqual({ result_ready: total });
    expect(h.result(first)).toBe('answer to part 0');
    await expect(h.agent({ key: 'task-0', prompt: 'part 0' })).rejects.toThrow('Duplicate agent key');
    // An archived call still feeds a later one.
    const [fed] = await h.run([{ key: 'fed', prompt: 'use it', inputs: ['task-7'] }]);
    expect(h.requests.at(-1)!.prompt).toContain('answer to part 7');
    expect(h.result(fed!)).toBe('answer to use it');
  }, 120_000);

  it('answers a replayed script from the archive without running its tasks again', async () => {
    const h = harness();
    await h.start(1000);
    const ids = await h.run(batch(0, 80));
    await h.age();
    expect(h.state().tasks).toHaveLength(0);
    expect(h.state().script!.archivedCalls).toBe(80);

    await h.call('pause');
    await h.call('replay_script');
    h.kernel.beginScript(h.root.scopeId, h.state().workflowId);
    expect(h.state().script!.archivedCalls).toBe(0);
    const replayed = (await Promise.all(batch(0, 80).map(h.agent))).map(item => item.taskId);
    expect(replayed).toEqual(ids);
    expect(h.requests).toHaveLength(80);
    expect(h.state().script!.archivedCalls).toBe(80);
    expect(h.state().tasks).toHaveLength(0);
    expect(h.result(ids[3]!)).toBe('answer to part 3');
    // The replayed run owns the keys again, and a changed prompt is a new task.
    await expect(h.agent({ key: 'task-3', prompt: 'part 3' })).rejects.toThrow('Duplicate agent key');
    await h.run([{ key: 'task-80', prompt: 'part 80' }]);
    expect(h.requests).toHaveLength(81);
    expect(h.state().archived!.tasks).toBe(80);
  });

  it('counts archived calls against the run budget', async () => {
    const h = harness();
    await h.start(70);
    await h.run(batch(0, 70));
    await h.age();
    expect(h.state().script!.calls).toHaveLength(0);
    await expect(h.agent({ key: 'one-more', prompt: 'over budget' })).rejects.toThrow('call limit');
  });

  it('keeps a member\'s turn chain across archived turns and a replay', async () => {
    const h = harness();
    await h.start(1000);
    const turns = Array.from({ length: 70 }, (_, index) => ({ key: 'turn-' + index, member: 'alice', prompt: 'step ' + index }));
    const ids: string[] = [];
    for (const turn of turns) ids.push(...await h.run([turn]));
    await h.run(batch(0, 64));
    await h.age();
    // The member's latest turn stays; the rest of its history and the one-shot tasks are archived.
    expect(h.state().tasks.map(task => task.taskId)).toEqual([ids.at(-1)]);
    expect(h.state().sessions).toHaveLength(1);
    expect(h.state().archived!.tasks).toBe(69 + 64);
    const [next] = await h.run([{ key: 'turn-70', member: 'alice', prompt: 'step 70' }]);
    expect(h.state().tasks.find(task => task.taskId === next)!.previousTurnId).toBe(ids.at(-1));

    await h.call('pause');
    await h.call('replay_script');
    h.kernel.beginScript(h.root.scopeId, h.state().workflowId);
    const before = h.requests.length;
    const replayed: string[] = [];
    for (const turn of turns) replayed.push((await h.agent(turn)).taskId);
    expect(replayed).toEqual(ids);
    expect(h.requests).toHaveLength(before);
    await expect(h.agent({ key: 'turn-70', member: 'alice', prompt: 'a different step' })).rejects.toThrow('Cannot rewrite member history');
  }, 60_000);

  it('rebuilds the same state and archive from the journal after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-archive-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'workflows.db');
    const first = harness(path);
    await first.start(1000);
    const ids = await first.run(batch(0, 100));
    await first.age();
    const before = first.state();
    expect(before.archived!.tasks).toBe(100);
    await first.kernel.close();

    const second = harness(path);
    const after = second.kernel.latest(second.root.scopeId)!;
    expect(after.archived).toEqual(before.archived);
    expect(after.tasks).toHaveLength(0);
    expect((await second.call('read_artifact', { workflowId: after.workflowId, expectedStateVersion: undefined, ref: 'missing' }).catch(error => String(error)))).toContain('Artifact not found');
    expect(ids).toHaveLength(100);
  });
});
