import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, WorkflowRuntime, type WorkerRunSpec, type WorkflowRoot } from '../src';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

type Behaviour = 'fail-after-claim' | 'hold' | 'drain';

describe('staffing a running swarm from the main agent', () => {
  it('revives a failed member, adds one and raises the wake-up limit without a replay', async () => {
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo', policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} };
    const plan: Record<string, Behaviour[]> = { w0: ['fail-after-claim', 'drain'], w1: ['hold'] };
    const turns: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let runtime!: WorkflowRuntime;
    const memberOf = (spec: WorkerRunSpec) => runtime.kernel.state(root.scopeId)!.agents!.find(agent => spec.sessionKey.endsWith(':' + agent.sessionRef))!.key;
    const work = async (spec: WorkerRunSpec, behaviour: Behaviour) => {
      const call = (method: string, args: Record<string, unknown> = {}) => callWorkflow(method, { operationId: randomUUID(), ...args }, spec.env);
      for (;;) {
        const grant = await call('claim_work') as { claimId: string; generation: number } | null;
        if (!grant) return;
        if (behaviour === 'fail-after-claim') throw new Error('boom');
        if (behaviour === 'hold') await held;
        await call('complete_work', { claimId: grant.claimId, generation: grant.generation, result: 'done' });
      }
    };
    runtime = new WorkflowRuntime({ path: ':memory:', resolveRoot: async () => root, wakeMain: async () => {},
      runner: { async start(spec) {
        await spec.validateBeforeRun();
        const name = memberOf(spec);
        const behaviour = plan[name]?.shift() ?? 'drain';
        turns.push(name + ':' + behaviour);
        const done = work(spec, behaviour).then(() => undefined, (error: Error) => error.message);
        return { runId: randomUUID(), result: done.then(error => error ? 'failed' as const : 'completed' as const), stop: async () => { release(); },
          waitForExit: async () => { await done; return true; }, stopReason: () => undefined,
          async *events() {
            yield { type: 'session' as const, nativeSessionId: spec.resume?.id ?? 'native-' + name };
            const error = await done;
            if (error) { yield { type: 'error' as const, message: error }; yield { type: 'done' as const, normal: false }; }
            else { yield { type: 'final_text' as const, text: 'queue drained' }; yield { type: 'done' as const, normal: true }; }
          } };
      } } });
    await runtime.start(); cleanup.push(async () => { release(); await runtime.close(); });
    const main = runtime.bindMain(root.scopeId, 'start'); cleanup.push(async () => main.release());
    const state = () => runtime.kernel.state(root.scopeId)!;
    const call = async (method: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      for (;;) {
        try { return await callWorkflow(method, { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args }, main.env); }
        catch (error) { if (!(error instanceof Error && error.message.startsWith('stateVersion conflict'))) throw error; }
      }
    };
    const member = (name: string) => (state().swarms![0]!.members.find(item => item.name === name) ?? {}) as { stopped?: string; turns?: number; queue?: string };
    await call('run_script', { goal: 'Drain a queue', plan: 'Two members consume six items.', maxAgents: 32, maxConcurrent: 4,
      script: 'const s = swarm("Claim and finish the queued work", {key:"crew", maxTurns:1, members:[{name:"w0",queue:"default",role:"fixer"},{name:"w1",queue:"default"}]});'
        + 'for (let i = 0; i < 6; i++) await enqueueWork({key:"item-"+i, title:"Item "+i, input:i});'
        + 'await closeWorkQueue({key:"closed"}); return await s;' });
    await vi.waitFor(async () => { await runtime.tick(); expect(member('w0').stopped).toBe('failed'); });
    // w1 still holds an item, so the swarm is alive with nobody to take the rest.
    expect(state().workQueue!.items.filter(item => item.status === 'completed')).toHaveLength(0);

    await expect(call('staff_swarm', { revive: ['w1'] })).rejects.toThrow('has not failed');
    await expect(call('staff_swarm', { maxTurns: 0 })).rejects.toThrow();
    await expect(call('staff_swarm', { swarm: 'other', add: ['x'] })).rejects.toThrow('No running swarm');
    await expect(call('staff_swarm', { add: ['w1'] })).rejects.toThrow('already used');
    await expect(call('staff_swarm', {})).rejects.toThrow('needs add, revive or maxTurns');
    expect(await call('staff_swarm', { revive: 'failed', add: ['w2'], like: 'w0', maxTurns: 4 })).toMatchObject({ swarm: 'crew', revived: ['w0'], added: ['w2'], maxTurns: 4 });
    expect(member('w0').stopped).toBeUndefined();
    expect(member('w2')).toMatchObject({ queue: 'default', role: 'fixer' });

    await vi.waitFor(async () => { await runtime.tick(); expect(state().workQueue!.items.filter(item => item.status === 'completed')).toHaveLength(5); }, { timeout: 5000 });
    release();
    await vi.waitFor(async () => { await runtime.tick(); expect(state().script?.status).toBe('result_ready'); }, { timeout: 5000 });
    expect(state().workQueue!.items.every(item => item.status === 'completed')).toBe(true);
    // The revived member retried its failed turn in the same session; the newcomer took part of the queue.
    expect(turns.filter(turn => turn.startsWith('w0'))).toEqual(['w0:fail-after-claim', 'w0:drain']);
    expect(turns).toContain('w2:drain');
    expect(state().swarms![0]).toMatchObject({ status: 'done', maxTurns: 4 });
  }, 30_000);
});
