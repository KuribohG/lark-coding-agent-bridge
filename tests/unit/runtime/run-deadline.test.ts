import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseRunDeadline } from '../../../src/runtime/run-deadline';
import { TimedRunStore } from '../../../src/runtime/timed-runs';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { AgentAdapter } from '../../../src/agent/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

afterEach(() => vi.useRealTimers());

describe('absolute task deadlines', () => {
  it('resolves the next 01:00 in the chosen timezone once, including across midnight', () => {
    expect(parseRunDeadline('01:00', 'Asia/Shanghai', Date.parse('2026-09-21T23:00+08:00')))
      .toBe(Date.parse('2026-09-22T01:00+08:00'));
    expect(parseRunDeadline('01:00', 'Asia/Shanghai', Date.parse('2026-09-22T00:30+08:00')))
      .toBe(Date.parse('2026-09-22T01:00+08:00'));
  });

  it('supports durations and explicit offsets without accepting ambiguous date strings', () => {
    const now = Date.parse('2026-09-21T23:00+08:00');
    expect(parseRunDeadline('90m', 'Asia/Shanghai', now)).toBe(now + 90 * 60_000);
    expect(parseRunDeadline('2h', 'Asia/Shanghai', now)).toBe(now + 2 * 3_600_000);
    expect(parseRunDeadline('2026-09-22T01:00+08:00', 'UTC', now)).toBe(now + 2 * 3_600_000);
    for (const value of ['25:00', '01:60', '0h', '200h', '2026-09-22 01:00']) {
      expect(() => parseRunDeadline(value, 'UTC', now)).toThrow();
    }
    expect(() => parseRunDeadline('2h', 'Invalid/Zone', now)).toThrow();
    expect(() => parseRunDeadline('2026-02-30T01:00Z', 'UTC', Date.parse('2026-02-28T00:00Z'))).toThrow('不存在');
  });

  it('chooses the remaining occurrence in a DST fold and skips nonexistent spring times', () => {
    expect(parseRunDeadline('01:30', 'America/New_York', Date.parse('2026-11-01T05:45Z')))
      .toBe(Date.parse('2026-11-01T06:30Z'));
    expect(parseRunDeadline('02:30', 'America/New_York', Date.parse('2026-03-08T05:00Z')))
      .toBe(Date.parse('2026-03-09T06:30Z'));
  });

  it('persists one-shot state, rejects duplicate starts, and never resumes after reload', async () => {
    const tmp = await createTmpProfile('timed-store-');
    try {
      const path = join(tmp.profile, 'timed-runs.json');
      const store = new TimedRunStore(path);
      const job = await store.create({ scope: 'chat:topic', owner: 'owner', task: 'review',
        timeZone: 'UTC', deadlineAt: Date.now() + 100_000, stopAt: Date.now() + 60_000,
        windDownAt: Date.now(), modelSettings: { reasoningEffort: 'ultra' } });
      await store.transition(job.id, ['draft'], 'queued');
      await expect(store.transition(job.id, ['draft'], 'queued')).rejects.toThrow();
      const restarted = new TimedRunStore(path);
      await restarted.load();
      expect(restarted.get(job.id)).toMatchObject({ state: 'interrupted', stopAt: job.stopAt });
      await expect(restarted.transition(job.id, ['draft'], 'queued')).rejects.toThrow();
      expect(JSON.parse(await readFile(path, 'utf8'))[0].state).toBe('interrupted');
    } finally { await tmp.cleanup(); }
  });

  it('removes an expired queued job without spawning or consuming a future slot', async () => {
    vi.useFakeTimers();
    const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
    const pool = new ProcessPool(() => 1);
    const held = await pool.acquire();
    const executor = new RunExecutor({ agent, pool, activeRuns: new ActiveRuns() });
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
    const executor = new RunExecutor({ agent, pool, activeRuns: new ActiveRuns() });
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
    const executor = new RunExecutor({ agent: adapter, pool, activeRuns: new ActiveRuns() });
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
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns() });
    const run = await executor.submit({ scopeId: 's', policy: policy(), deadlineAt: Date.now() + 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(agent.runs[0]?.stopped).toBe(true);
    expect(run.handle.stopReason).toBe('deadline');
    for await (const _ of run.subscribe()) { /* drain */ }
    expect(await run.result).toBe('expired');
  });

  it('does not relabel a completed task when final rendering requests cleanup', async () => {
    const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns() });
    const run = await executor.submit({ scopeId: 's', policy: policy(), deadlineAt: Date.now() + 60_000 });
    for await (const _ of run.subscribe()) { /* drain */ }
    await run.stop();
    expect(await run.result).toBe('completed');
  });

  it('settles and frees the scope even if the adapter exit check fails', async () => {
    const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
    const pool = new ProcessPool(() => 1);
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent, pool, activeRuns });
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
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns() });
    const run = await executor.submit({ scopeId: 's', policy: policy(), deadlineAt: Date.now() + 60_000 });
    for await (const _ of run.subscribe()) { /* drain */ }
    expect(await run.result).toBe('quota');
    expect(agent.runs).toHaveLength(1);
  });
});

function policy(): RunPolicyAllow {
  return { ok: true, prompt: 'task', requestedCwd: '/repo', cwdRealpath: '/repo', accessMode: 'workspace',
    sandbox: 'workspace-write', permissionMode: 'acceptEdits', access: { ok: true, reason: 'allowed-user' },
    attachments: [], policyFingerprint: 'fp', expiresAt: Date.now() + 60_000 };
}
