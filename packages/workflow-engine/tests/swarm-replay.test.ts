import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, WorkflowRuntime, type WorkerRunSpec, type WorkflowRoot } from '../src';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

type Behaviour = 'fail-after-claim' | 'drain' | 'idle';

/** A runtime whose workers follow a per-member plan: fail holding a claim, drain the queue, or end the turn at once. */
async function harness(plan: Record<string, Behaviour[]>, usual: Record<string, Behaviour> = {}) {
  const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo', policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} };
  const turns: string[] = [];
  let runtime!: WorkflowRuntime;
  const memberOf = (spec: WorkerRunSpec) => runtime.kernel.state(root.scopeId)!.agents!.find(agent => spec.sessionKey.endsWith(':' + agent.sessionRef))!.key;
  const work = async (spec: WorkerRunSpec, behaviour: Behaviour) => {
    if (behaviour === 'idle') return;
    const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method, { operationId: randomUUID(), ...args }, spec.env);
    for (;;) {
      const grant = await call('claim_work') as { claimId: string; generation: number } | null;
      if (!grant) return;
      if (behaviour === 'fail-after-claim') throw new Error('boom');
      await call('complete_work', { claimId: grant.claimId, generation: grant.generation, result: 'done' });
    }
  };
  runtime = new WorkflowRuntime({ path: ':memory:', resolveRoot: async () => root, wakeMain: async () => {},
    runner: { async start(spec) {
      await spec.validateBeforeRun();
      const name = memberOf(spec);
      const behaviour = plan[name]?.shift() ?? usual[name] ?? 'drain';
      turns.push(name + ':' + behaviour);
      const done = work(spec, behaviour).then(() => undefined, (error: Error) => error.message);
      return { runId: randomUUID(), result: done.then(error => error ? 'failed' as const : 'completed' as const), stop: async () => {},
        waitForExit: async () => { await done; return true; }, stopReason: () => undefined,
        async *events() {
          yield { type: 'session' as const, nativeSessionId: spec.resume?.id ?? 'native-' + name };
          const error = await done;
          if (error) { yield { type: 'error' as const, message: error }; yield { type: 'done' as const, normal: false }; }
          else { yield { type: 'final_text' as const, text: 'turn done' }; yield { type: 'done' as const, normal: true }; }
        } };
    } } });
  await runtime.start(); cleanup.push(async () => runtime.close());
  const main = runtime.bindMain(root.scopeId, 'start'); cleanup.push(async () => main.release());
  const state = () => runtime.kernel.state(root.scopeId)!;
  const call = async (method: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    for (;;) {
      try { return await callWorkflow(method, { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args }, main.env); }
      catch (error) { if (!(error instanceof Error && error.message.startsWith('stateVersion conflict'))) throw error; }
    }
  };
  const swarm = () => state().swarms![0]!;
  const member = (name: string) => (state().swarms?.[0]?.members ?? []).find(item => item.name === name) ?? { name } as ReturnType<typeof swarm>['members'][number];
  const item = (key: string) => state().workQueue!.items.find(entry => entry.key === key);
  const until = (check: () => void) => vi.waitFor(async () => { await runtime.tick(); check(); }, { timeout: 5000 });
  return { runtime, turns, state, call, swarm, member, item, until };
}

describe('replaying a script whose swarm lost members', () => {
  it('runs a failed swarm again: its failed members retry and its closed queues take work', async () => {
    const h = await harness({ w0: ['fail-after-claim', 'fail-after-claim'] });
    await h.call('run_script', { goal: 'Drain a queue', plan: 'One member consumes the queue.', maxAgents: 32, maxConcurrent: 4,
      script: 'const s = swarm("Claim and finish the queued work", {key:"crew", maxTurns:8, members:[{name:"w0",queue:"default"}]});'
        + 'await enqueueWork({key:"item-0", title:"Item 0", input:0});'
        + 'const result = await s; await closeWorkQueue({key:"closed"}); return result;' });
    // The only consumer stops at its second failure, so the swarm fails and the script closes the queue behind it.
    await h.until(() => expect(h.state().script?.status).toBe('failed'));
    expect(h.state().script!.error).toContain('unfinished work items');
    expect(h.swarm()).toMatchObject({ status: 'done', stop: 'failed' });
    expect(h.member('w0').stopped).toBe('failed');
    expect(h.state().workQueue!.closedAt).toBeDefined();
    await expect(h.call('enqueue_work', { key: 'late', title: 'Late', input: 0 })).rejects.toThrow();

    await h.call('replay_script');
    await h.until(() => expect(h.item('item-0')?.status ?? 'archived').not.toBe('pending'));
    expect(h.swarm()).toMatchObject({ status: 'running' });
    expect(h.swarm().stop).toBeUndefined();
    expect(h.member('w0').stopped).toBeUndefined();
    expect(h.state().workQueue!.closedAt).toBeUndefined();
    // The retried turn ran in the member's session, and the member is woken for work added afterwards.
    await h.call('enqueue_work', { key: 'item-1', title: 'Item 1', input: 1 });
    await h.until(() => expect(h.item('item-1')?.status).toBe('completed'));
    expect(h.turns).toEqual(['w0:fail-after-claim', 'w0:fail-after-claim', 'w0:drain', 'w0:drain']);

    await h.call('close_work_queue');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.swarm()).toMatchObject({ status: 'done', stop: 'quiet' });
    expect(h.state().script?.error).toBeUndefined();
    expect(h.state().workQueue!.closedAt).toBeDefined();
  }, 30_000);

  it('keeps waking a member that was revived after a replay', async () => {
    const h = await harness({ w0: ['fail-after-claim', 'fail-after-claim'] }, { boss: 'idle' });
    await h.call('run_script', { goal: 'Drain a queue', plan: 'A lead and one consumer.', maxAgents: 64, maxConcurrent: 4,
      script: 'const s = swarm("Claim and finish the queued work", {key:"crew", lead:{name:"boss"}, maxTurns:8, members:[{name:"w0",queue:"default"}]});'
        + 'await enqueueWork({key:"item-0", title:"Item 0", input:0}); return await s;' });
    await h.until(() => expect(h.member('w0').stopped).toBe('failed'));
    const failedTurn = h.member('w0').taskId;
    const firstRun = h.state().script!.runId;

    // The swarm is still running when the script is replayed, so the member that failed before stays stopped.
    await h.call('pause');
    await h.call('replay_script');
    await h.until(() => { expect(h.state().script!.runId).not.toBe(firstRun); expect(h.swarm().runId).toBe(h.state().script!.runId); });
    expect(h.member('w0').stopped).toBe('failed');

    expect(await h.call('staff_swarm', { revive: 'failed' })).toMatchObject({ revived: ['w0'] });
    await h.until(() => expect(h.item('item-0')?.status).toBe('completed'));
    // The turn it finished belongs to this run's calls, so the member's history is whole.
    expect(h.member('w0').taskId).toBe(failedTurn);
    expect(h.state().script!.calls.filter(entry => entry.taskId === failedTurn)).toHaveLength(1);

    await h.call('enqueue_work', { key: 'item-1', title: 'Item 1', input: 1 });
    await h.until(() => expect(h.item('item-1')?.status).toBe('completed'));
    expect(h.swarm()).toMatchObject({ status: 'running' });
    expect(h.member('w0').stopped).toBeUndefined();
    expect(h.turns.filter(turn => turn.startsWith('w0'))).toEqual(['w0:fail-after-claim', 'w0:fail-after-claim', 'w0:drain', 'w0:drain']);
    expect(h.state().events.filter(event => event.summary?.includes('无法被唤醒'))).toHaveLength(0);
  }, 30_000);
});
