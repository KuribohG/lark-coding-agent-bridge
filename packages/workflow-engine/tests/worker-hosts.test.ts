import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, stopReasonOf, WorkflowRuntime, type WorkerRunner, type WorkerRunSpec, type WorkflowRoot, type WorkflowStopReason } from '../src';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface FakeHost { agentKind: string; finish(text: string): void; done: Promise<string> }

/** Hosted processes that survive WorkflowRuntime.close, as bin/run-host.mjs does for the bridge. */
function hostedRunner() {
  const hosts = new Map<string, FakeHost>();
  const released: string[] = [];
  const specs: WorkerRunSpec[] = [];
  const runner: WorkerRunner = {
    hosting: {
      newKey: () => randomUUID(),
      attachable: async (key, agentKind) => hosts.get(key)?.agentKind === agentKind,
      release: async key => { released.push(key); hosts.delete(key); },
    },
    async start(spec) {
      specs.push(spec);
      await spec.validateBeforeRun();
      const key = spec.host!.key;
      if (!spec.host!.attach) {
        let finish!: (text: string) => void;
        const done = new Promise<string>(resolve => { finish = resolve; });
        hosts.set(key, { agentKind: spec.execution.agentKind, finish, done });
      }
      const host = hosts.get(key)!;
      let stopped: WorkflowStopReason | undefined;
      let wake!: () => void;
      const interrupted = new Promise<undefined>(resolve => { wake = () => resolve(undefined); });
      spec.signal.addEventListener('abort', () => { stopped ??= stopReasonOf(spec.signal); wake(); }, { once: true });
      const outcome = Promise.race([host.done, interrupted]);
      return {
        runId: randomUUID(), result: outcome.then(text => text === undefined ? 'stopped' : 'completed'),
        stop: async reason => { stopped ??= reason; wake(); }, waitForExit: async () => true, stopReason: () => stopped,
        async *events() {
          // A process that resumes a session reports that session.
          yield { type: 'session', nativeSessionId: spec.resume?.id ?? `native-${key}` };
          const text = await outcome;
          if (text === undefined) return;
          yield { type: 'final_text', text };
          yield { type: 'done', normal: true };
        },
      };
    },
  };
  return { runner, hosts, released, specs };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'worker-hosts-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  let root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo',
    policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} };
  const fake = hostedRunner();
  const notify = vi.fn(async (_state: unknown, _text: string) => {});
  const create = () => new WorkflowRuntime({ path: join(dir, 'workflows.sqlite'), resolveRoot: async () => root,
    wakeMain: async () => {}, notify, runner: fake.runner });
  let runtime = create();
  await runtime.start();
  cleanup.push(() => runtime.close());
  const state = () => runtime.kernel.state(root.scopeId)!;
  const until = (check: () => void) => vi.waitFor(async () => { await runtime.tick(); check(); }, { timeout: 5000, interval: 20 });
  return {
    ...fake, notify, state, until,
    get runtime() { return runtime; },
    async run(script: string) {
      const main = runtime.bindMain(root.scopeId, 'start');
      await callWorkflow('run_script', { operationId: randomUUID(), goal: 'hosted', plan: 'One long worker.', script }, main.env);
      main.release();
    },
    restart: async () => { await runtime.close(); runtime = create(); await runtime.start(); },
    changeRoot: () => { root = { ...root, catalogBinding: 'replacement' }; },
  };
}

describe('hosted workflow workers', () => {
  it('reattaches a worker that kept running across a restart and keeps its workflow token valid', async () => {
    const h = await harness();
    await h.run('return await agent("long task", {key:"long"});');
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!;
    expect(first.host).toMatchObject({ attach: false });
    await expect(callWorkflow('task_status', {}, first.env)).resolves.toBeTruthy();

    await h.restart();
    await h.until(() => expect(h.specs).toHaveLength(2));
    expect(h.specs[1]!.host).toEqual({ key: first.host!.key, attach: true });
    expect(h.released).toEqual([]);
    expect(h.notify.mock.calls[0]![1]).toContain('接回原进程');
    // The process still carries the old endpoint and token; the published endpoint routes it to the new controller.
    await h.until(() => expect(h.state().tasks.at(-1)?.status).toBe('running'));
    await expect(callWorkflow('task_status', {}, first.env)).resolves.toBeTruthy();

    h.hosts.get(first.host!.key)!.finish('finished while detached');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    const result = h.state().artifacts.find(artifact => artifact.ref === h.state().script!.resultRef)!;
    expect(JSON.parse(result.text)).toBe('finished while detached');
    expect(h.released).toEqual([first.host!.key]);
    await expect(callWorkflow('task_status', {}, first.env)).rejects.toThrow('revoked');
  });

  it('reattaches a persistent member turn in the same task', async () => {
    const h = await harness();
    await h.run('return await agent("long task", {key:"turn", member:"A"});');
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const taskId = h.state().tasks[0]!.taskId;
    await h.restart();
    await h.until(() => expect(h.specs).toHaveLength(2));
    expect(h.specs[1]!.host).toEqual({ key: h.specs[0]!.host!.key, attach: true });
    h.hosts.get(h.specs[0]!.host!.key)!.finish('member answer');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().tasks).toHaveLength(1);
    expect(h.state().tasks[0]).toMatchObject({ taskId, status: 'result_ready' });
  });

  it('lets a reattached member finish the work claim it held before the restart', async () => {
    const h = await harness();
    await h.run('await enqueueWork({key:"work", title:"Work", input:null}); return await agent("consume", {key:"turn", member:"A"});');
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!;
    const grant = await callWorkflow('claim_work', { operationId: 'claim-1' }, first.env) as { claimId: string; generation: number };

    await h.restart();
    await h.until(() => expect(h.specs).toHaveLength(2));
    expect(h.specs[1]!.host).toEqual({ key: first.host!.key, attach: true });
    expect(h.released).toEqual([]);
    expect(h.state().workQueue!.claims[0]).toMatchObject({ id: grant.claimId, status: 'active', attemptId: h.state().tasks[0]!.attempts.at(-1)!.attemptId });
    // The process never learns of the restart: it completes with the claim ID and generation it was given.
    await callWorkflow('complete_work', { operationId: 'done-1', claimId: grant.claimId, generation: grant.generation, result: 'done' }, first.env);
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed', result: 'done', generation: 1 });
    h.hosts.get(first.host!.key)!.finish('member answer');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
  });

  it('keeps every swarm member on its own work item across a restart', async () => {
    const h = await harness();
    await h.run('for (const n of [0, 1]) await enqueueWork({key:"item-" + n, title:"Item " + n, input:n});'
      + 'return await swarm("Claim and finish the queued work", {key:"crew", maxTurns:4, members:[{name:"w0",queue:"default"},{name:"w1",queue:"default"}]});');
    await h.until(() => expect(h.specs).toHaveLength(2));
    const grants = await Promise.all(h.specs.map(spec => callWorkflow('claim_work', { operationId: 'claim-1' }, spec.env) as Promise<{ claimId: string; generation: number; item: { key: string } }>));
    expect(grants.map(grant => grant.item.key).sort()).toEqual(['item-0', 'item-1']);

    await h.restart();
    await h.until(() => expect(h.specs).toHaveLength(4));
    expect(h.specs.slice(2).map(spec => spec.host!.attach)).toEqual([true, true]);
    expect(h.released).toEqual([]);
    expect(h.state().workQueue!.claims.map(claim => claim.status)).toEqual(['active', 'active']);
    for (const [index, grant] of grants.entries()) {
      await callWorkflow('complete_work', { operationId: 'done-1', claimId: grant.claimId, generation: grant.generation, result: grant.item.key }, h.specs[index]!.env);
    }
    expect(h.state().workQueue!.items.map(item => [item.status, item.generation, item.result])).toEqual([['completed', 1, 'item-0'], ['completed', 1, 'item-1']]);
    expect(h.state().workQueue!.claims).toHaveLength(2);
  });

  it('does not continue the turn of a caller that had started a child workflow, and resumes the caller with the child\'s result', async () => {
    const h = await harness();
    await h.run('return await agent("delegate", {key:"parent", workflowTool:true});');
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!;
    // The caller has committed its child and not yet ended its turn when the controller goes away.
    await expect(callWorkflow('run_workflow', { operationId: 'delegate', key: 'delegate', goal: 'Return the answer',
      plan: 'Return 42 without workers.', script: 'return 42;' }, first.env)).resolves.toMatchObject({ status: 'waiting' });

    await h.restart();
    await h.until(() => expect(h.specs).toHaveLength(2));
    // All that turn had left to do was to end, and what it says then is not the caller's answer: its process is ended,
    // and the caller resumes in its session with the result of the child, which ran meanwhile.
    expect(h.released).toEqual([first.host!.key]);
    const resumed = h.specs[1]!;
    expect(resumed.host!.attach).toBe(false);
    expect(resumed.resume).toEqual({ kind: 'sessionId', id: `native-${first.host!.key}` });
    await expect(callWorkflow('read_context', {}, resumed.env)).resolves.toMatchObject({ workflows: { call: { ok: true, result: 42 } } });
    await expect(callWorkflow('task_status', {}, first.env)).rejects.toThrow();
    h.hosts.get(resumed.host!.key)!.finish('the answer is 42');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(JSON.parse(h.state().artifacts.find(artifact => artifact.ref === h.state().script!.resultRef)!.text)).toBe('the answer is 42');
    expect(h.state().tasks[0]!.attempts).toHaveLength(2);
  });

  it('starts a fresh process when the host did not survive', async () => {
    const h = await harness();
    await h.run('return await agent("long task", {key:"long"});');
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const lost = h.specs[0]!.host!.key;
    h.hosts.delete(lost);

    await h.restart();
    await h.until(() => expect(h.specs).toHaveLength(2));
    expect(h.specs[1]!.host!.attach).toBe(false);
    expect(h.specs[1]!.host!.key).not.toBe(lost);
    expect(h.released).toContain(lost);
    h.hosts.get(h.specs[1]!.host!.key)!.finish('rerun');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
  });

  it('ends surviving workers of a workflow that does not resume', async () => {
    const h = await harness();
    await h.run('return await agent("long task", {key:"long"});');
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const key = h.specs[0]!.host!.key;
    h.changeRoot();

    await h.restart();
    expect(h.state()).toMatchObject({ status: 'interrupted', restart: { resume: false } });
    expect(h.released).toEqual([key]);
    expect(h.hosts.size).toBe(0);
  });

  it('ends a cancelled worker instead of leaving it for a restart', async () => {
    const h = await harness();
    await h.run('return await agent("long task", {key:"long"});');
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const key = h.specs[0]!.host!.key;
    h.runtime.kernel.cancel('chat');
    await h.until(() => expect(h.released).toEqual([key]));
    await h.restart();
    expect(h.specs).toHaveLength(1);
  });
});
