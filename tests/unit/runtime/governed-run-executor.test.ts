import { describe, expect, it } from 'vitest';
import { preparedRun } from '../../../src/agent/prepared-run';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions, StopSettlement } from '../../../src/agent/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';

const policy = (): RunPolicyAllow => ({ ok: true, prompt: 'fixture', requestedCwd: '/repo', cwdRealpath: '/repo',
  accessMode: 'read-only', sandbox: 'read-only', permissionMode: 'plan', access: { ok: true, reason: 'allowed-user' },
  attachments: [], policyFingerprint: 'fixture', expiresAt: Date.now() + 60_000 });

/** A native run that stays open until it is stopped or the test ends it. */
function fixture(options: { quiescence?: () => StopSettlement['state']; slots?: number } = {}) {
  const calls = { starts: 0, stops: 0, exits: 0, drains: 0 };
  const ends: Array<(event: AgentEvent) => void> = [];
  const adapter: AgentAdapter = {
    id: 'claude', displayName: 'Fixture', capabilities: { finalAnswer: 'separate-event', input: 'unsupported' },
    isAvailable: async () => true,
    prepareRun: async (run: AgentRunOptions) => preparedRun({}, (): AgentRun => {
      calls.starts++;
      const terminal = new Promise<AgentEvent>((resolve) => { ends.push(resolve); });
      const end = ends.at(-1)!;
      return {
        runId: run.runId, capabilities: adapter.capabilities,
        events: (async function* () { yield await terminal; })(),
        async stop() { calls.stops++; end({ type: 'done', terminationReason: 'interrupted' }); },
        async waitForExit() { calls.exits++; return true; },
        ...(options.quiescence ? { async waitForQuiescence() {
          calls.drains++;
          return { state: options.quiescence!() };
        } } : {}),
      };
    }),
  };
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => options.slots ?? 1);
  const executor = new RunExecutor({ resolveAgent: () => adapter, activeRuns, pool, postDoneExitGraceMs: 1 });
  return { calls, ends, activeRuns, pool, executor };
}

describe('RunExecutor governed hosts', () => {
  it('frees an ordinary scope on interrupt and keeps a governed one until native drain', async () => {
    const ordinary = fixture();
    await ordinary.executor.submit({ scopeId: 'scope', policy: policy() });
    expect(ordinary.activeRuns.interrupt('scope')).toBe(true);
    expect(ordinary.activeRuns.get('scope')).toBeUndefined();

    const governed = fixture();
    const execution = await governed.executor.submit({ scopeId: 'scope', policy: policy(), governed: true });
    expect(governed.activeRuns.interrupt('scope')).toBe(true);
    expect(governed.activeRuns.get('scope')).toBeDefined();
    expect(await execution.result).toBe('stopped');
    expect(governed.activeRuns.get('scope')).toBeUndefined();
  });

  it('stopAll keeps only governed scopes until they drain', async () => {
    const h = fixture({ slots: 2 });
    const executor = h.executor;
    await executor.submit({ scopeId: 'ordinary', policy: policy() });
    const governed = await executor.submit({ scopeId: 'governed', policy: policy(), governed: true });
    const stopping = h.activeRuns.stopAll();
    expect(h.activeRuns.get('ordinary')).toBeUndefined();
    expect(h.activeRuns.get('governed')).toBeDefined();
    await stopping;
    expect(await governed.result).toBe('stopped');
    expect(h.activeRuns.get('governed')).toBeUndefined();
  });

  it('waits for process exit on an ordinary stop and for native quiescence on a governed one', async () => {
    const ordinary = fixture({ quiescence: () => 'quiescent' });
    await (await ordinary.executor.submit({ scopeId: 'scope', policy: policy() })).stop();
    expect(ordinary.calls).toMatchObject({ stops: 1, drains: 0 });
    expect(ordinary.calls.exits).toBeGreaterThan(0);

    const governed = fixture({ quiescence: () => 'quiescent' });
    const execution = await governed.executor.submit({ scopeId: 'scope', policy: policy(), governed: true });
    await execution.stop();
    expect(governed.calls).toMatchObject({ stops: 1, exits: 0 });
    expect(governed.calls.drains).toBeGreaterThan(0);
    expect(await execution.result).toBe('stopped');
  });

  it('holds the scope and slot through an unknown settlement until reconciliation proves drain', async () => {
    let state: StopSettlement['state'] = 'unknown';
    const h = fixture({ quiescence: () => state });
    const execution = await h.executor.submit({ scopeId: 'scope', policy: policy(), governed: true });
    await execution.stop();
    expect(await execution.result).toBe('unknown');
    expect(h.activeRuns.get('scope')).toBeDefined();
    expect(h.pool.tryAcquire()).toBeUndefined();
    await expect(h.executor.submit({ scopeId: 'scope', policy: policy(), governed: true }))
      .rejects.toMatchObject({ code: 'run-already-active', confirmedNotSubmitted: true });
    expect((await execution.reconcile()).state).toBe('unknown');

    state = 'quiescent';
    expect((await execution.reconcile()).state).toBe('quiescent');
    expect(h.activeRuns.get('scope')).toBeUndefined();
    const release = h.pool.tryAcquire();
    expect(release).toBeTypeOf('function');
    release!();
    expect(await execution.result).toBe('unknown');
  });

  it('cancels a governed run waiting for its slot and leaves ordinary queued work to its caller', async () => {
    const governed = fixture();
    const held = governed.pool.tryAcquire()!;
    const waiting = governed.executor.submit({ scopeId: 'scope', policy: policy(), governed: true });
    governed.activeRuns.interrupt('scope');
    held();
    await expect(waiting).rejects.toMatchObject({ confirmedNotSubmitted: true });
    expect(governed.calls.starts).toBe(0);

    const ordinary = fixture();
    const heldOrdinary = ordinary.pool.tryAcquire()!;
    const queued = ordinary.executor.submit({ scopeId: 'scope', policy: policy() });
    ordinary.activeRuns.interrupt('scope');
    heldOrdinary();
    await queued;
    expect(ordinary.calls.starts).toBe(1);
  });

  it('settles a governed run without any subscriber', async () => {
    const h = fixture();
    const execution = await h.executor.submit({ scopeId: 'scope', policy: policy(), governed: true });
    h.ends[0]!({ type: 'done', terminationReason: 'normal' });
    expect(await execution.result).toBe('completed');
    expect(h.activeRuns.get('scope')).toBeUndefined();
  });
});
