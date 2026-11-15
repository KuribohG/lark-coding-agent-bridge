import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { ProcessPool } from '../../../src/runtime/process-pool';
import type { AgentAdapter } from '../../../src/agent/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

afterEach(() => vi.useRealTimers());

describe('executor deadlines', () => {
  it('removes an expired queued job without spawning or consuming a future slot', async () => {
    vi.useFakeTimers();
    const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
    const pool = new ProcessPool(() => 1);
    const held = await pool.acquire();
    const executor = new RunExecutor({ resolveAgent: () => agent, pool, activeRuns: new ActiveRuns() });
    const pending = executor.submit({ scopeId: 's', policy: policy(), deadlineAt: Date.now() + 1000 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'deadline-expired' });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    held();
    expect(agent.runs).toHaveLength(0);
    const next = await executor.submit({ scopeId: 's', policy: policy() });
    for await (const _ of next.subscribe()) { /* drain */ }
    expect(await next.result).toBe('completed');
    expect(pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('cancels queued work and releases its scope reservation', async () => {
    const agent = new FakeAgentAdapter();
    const pool = new ProcessPool(() => 1);
    const release = await pool.acquire();
    const executor = new RunExecutor({ resolveAgent: () => agent, pool, activeRuns: new ActiveRuns() });
    const controller = new AbortController();
    const pending = executor.submit({ scopeId: 's', policy: policy(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'run-cancelled' });
    release();
    expect(pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    expect(agent.runs).toHaveLength(0);
  });

  it('rechecks after prepareRun and never spawns after the deadline', async () => {
    vi.useFakeTimers();
    const agent = new FakeAgentAdapter();
    let prepared!: () => void;
    const adapter: AgentAdapter = Object.assign(agent, {
      prepareRun: () => new Promise<void>((resolve) => { prepared = resolve; }),
    });
    const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ resolveAgent: () => adapter, pool, activeRuns: new ActiveRuns() });
    const pending = executor.submit({ scopeId: 's', policy: policy(), deadlineAt: Date.now() + 1000 });
    await Promise.resolve();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'deadline-expired' });
    await vi.advanceTimersByTimeAsync(1000);
    prepared();
    await rejected;
    expect(agent.runs).toHaveLength(0);
    expect(pool.snapshot()).toMatchObject({ active: 0 });
  });

  it('stops running work despite continuous tool activity and reports deadline termination', async () => {
    vi.useFakeTimers();
    const agent = new FakeAgentAdapter();
    const executor = new RunExecutor({ resolveAgent: () => agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns() });
    const run = await executor.submit({ scopeId: 's', policy: policy(), deadlineAt: Date.now() + 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(agent.runs[0]?.stopped).toBe(true);
    expect(run.handle.stopReason).toBe('deadline');
    for await (const _ of run.subscribe()) { /* drain */ }
    expect(await run.result).toBe('expired');
  });

  it('does not relabel a completed task when final rendering requests cleanup', async () => {
    const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
    const executor = new RunExecutor({ resolveAgent: () => agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns() });
    const run = await executor.submit({ scopeId: 's', policy: policy(), deadlineAt: Date.now() + 60_000 });
    for await (const _ of run.subscribe()) { /* drain */ }
    await run.stop();
    expect(await run.result).toBe('completed');
  });

  it('settles and frees the scope even if the adapter exit check fails', async () => {
    const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
    const pool = new ProcessPool(() => 1);
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ resolveAgent: () => agent, pool, activeRuns });
    const run = await executor.submit({ scopeId: 's', policy: policy() });
    run.run.waitForExit = async () => { throw new Error('exit check failed'); };
    for await (const _ of run.subscribe()) { /* drain */ }
    expect(await run.result).toBe('failed');
    expect(agent.runs[0]?.stopped).toBe(true);
    expect(activeRuns.get('s')).toBeUndefined();
    expect(pool.snapshot()).toMatchObject({ active: 0 });
  });

  it('classifies explicit quota errors without retrying', async () => {
    const agent = new FakeAgentAdapter({ events: [{ type: 'error', message: 'insufficient_quota', terminationReason: 'failed' }] });
    const executor = new RunExecutor({ resolveAgent: () => agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns() });
    const run = await executor.submit({ scopeId: 's', policy: policy(), deadlineAt: Date.now() + 60_000 });
    for await (const _ of run.subscribe()) { /* drain */ }
    expect(await run.result).toBe('quota');
    expect(agent.runs).toHaveLength(1);
  });

  it('classifies a gateway budget_exceeded error as quota', async () => {
    const agent = new FakeAgentAdapter({ events: [{ type: 'error', terminationReason: 'failed',
      message: 'API Error: 400 {"error":{"message":"Budget has been exceeded! Current cost: 5","type":"budget_exceeded"}}' }] });
    const executor = new RunExecutor({ resolveAgent: () => agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns() });
    const run = await executor.submit({ scopeId: 's', policy: policy(), deadlineAt: Date.now() + 60_000 });
    for await (const _ of run.subscribe()) { /* drain */ }
    expect(await run.result).toBe('quota');
  });
});

function policy(): RunPolicyAllow {
  return { ok: true, prompt: 'task', requestedCwd: '/repo', cwdRealpath: '/repo', accessMode: 'workspace',
    sandbox: 'workspace-write', permissionMode: 'acceptEdits', access: { ok: true, reason: 'allowed-user' },
    attachments: [], policyFingerprint: 'fp', expiresAt: Date.now() + 60_000 };
}
