import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../../../src/workflows/kernel';
import { handleWorkflowCommand } from '../../../src/workflows/commands';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult, WorkflowWorkItem } from '../../../src/workflows/types';

type Grant = { claimId: string; generation: number; leaseUntil: number; item: WorkflowWorkItem };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function harness(path = ':memory:') {
  let now = 1_000_000;
  let root: WorkflowRoot = { scopeId: 'queue-test', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace',
    policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishers = new Map<string, (result: WorkflowWorkerResult) => void>();
  const host = { resolveRoot: async () => root, wakeMain: async () => {},
    execute: async (request: WorkflowWorkerRequest) => {
      requests.push(request);
      request.onRun('run-' + request.attemptId);
      request.onSession(request.session.nativeSessionId ?? 'native-' + request.session.actorId);
      return new Promise<WorkflowWorkerResult>(resolve => {
        finishers.set(request.attemptId, resolve);
        request.signal.addEventListener('abort', () => resolve({ status: 'completed', text: 'late native result' }), { once: true });
      });
    } };
  let kernel = new WorkflowKernel(path, host, () => now);
  cleanup.push(() => kernel.close());
  const state = () => kernel.state(root.scopeId)!;
  const call = (method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'main', scopeId: root.scopeId, allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...args });
  const work = (kind: string, args: Record<string, unknown> = {}) => kernel.scriptWork(root.scopeId, state().workflowId, state().script!.runId, { kind, ...args });
  const send = (request: WorkflowWorkerRequest, method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'worker',
    scopeId: root.scopeId, workflowId: state().workflowId, taskId: request.task.taskId, attemptId: request.attemptId }, method,
  { ...(method === 'work_status' || method === 'read_context' ? {} : { operationId: randomUUID() }), ...args });
  const create = (member?: string, key = 'consumer-' + member) => kernel.scriptAgent(root.scopeId, state().workflowId, state().script!.runId,
    { key, ...(member ? { member } : {}), prompt: 'Consume the authorized work queue' });
  const run = async (count: number) => { await kernel.tick(); await vi.waitFor(() => expect(requests).toHaveLength(count)); };
  const settle = (request: WorkflowWorkerRequest) => vi.waitFor(() => expect(['starting', 'running', 'cancelling']).not.toContain(state().tasks.find(task => task.taskId === request.task.taskId)!.status));
  return { get kernel() { return kernel; }, state, requests, call, work, send, create, run, settle,
    claim: (request: WorkflowWorkerRequest, args: Record<string, unknown> = {}) => send(request, 'claim_work', args) as Promise<Grant | null>,
    finish: async (request: WorkflowWorkerRequest) => { finishers.get(request.attemptId)!({ status: 'completed', text: 'done' }); await settle(request); },
    advance: (milliseconds: number) => { now += milliseconds; },
    changeRoot: () => { root = { ...root, catalogBinding: 'changed' }; },
    restart: async () => { await kernel.close(); kernel = new WorkflowKernel(path, host, () => now); },
    start: async () => {
      await call('run_script', { goal: 'Consume work items', plan: 'Three persistent members consume the queue and recover interrupted work.', script: 'return null;' });
      kernel.beginScript(root.scopeId, state().workflowId);
    },
    begin: () => kernel.beginScript(root.scopeId, state().workflowId),
    command: (args: string) => handleWorkflowCommand(kernel, root.scopeId, args, () => { throw new Error('Status must not launch an agent'); }),
  };
}

const token = (grant: Grant) => ({ claimId: grant.claimId, generation: grant.generation });

describe('workflow work queue', () => {
  it('lets three members consume ten items, reclaiming progress after lease expiry and rejecting late results', async () => {
    const h = harness(); await h.start();
    for (let n = 0; n < 10; n++) await h.work('enqueue', { key: 'item-' + n, title: 'Compute ' + n, input: n });
    for (const member of ['A', 'B', 'C']) await h.create(member);
    await h.run(3);
    const [a, b, c] = h.requests;
    const initial = await Promise.all(h.requests.map((request, i) => h.claim(request, { leaseMs: i === 0 ? 1000 : 120_000 })));
    expect(new Set(initial.map(grant => grant!.item.id)).size).toBe(3);
    const first = initial[0]!;
    await h.send(a!, 'checkpoint_work', { ...token(first), expectedProgressVersion: 0, state: { prepared: 'partial-work' } });
    h.advance(1001); await h.kernel.tick(); await h.settle(a!);
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'pending', progress: { version: 1, state: { prepared: 'partial-work' } } });
    await h.send(b!, 'complete_work', { ...token(initial[1]!), result: 1 });
    const replacement = (await h.claim(b!))!;
    expect(replacement.item.id).toBe(first.item.id);
    expect(replacement.generation).toBe(2);
    expect(replacement.item.progress).toMatchObject({ version: 1, state: { prepared: 'partial-work' } });
    await expect(h.send(a!, 'complete_work', { ...token(first), result: 'late' })).rejects.toThrow('inactive');
    await expect(h.send(b!, 'checkpoint_work', { ...token(replacement), generation: 1, expectedProgressVersion: 1, state: 'stale' })).rejects.toThrow('stale');
    await expect(h.send(c!, 'complete_work', { ...token(replacement), result: 'wrong-owner' })).rejects.toThrow('stale');
    await h.send(b!, 'complete_work', { ...token(replacement), result: 0 });
    await h.send(c!, 'complete_work', { ...token(initial[2]!), result: 4 });
    for (;;) {
      const grants = await Promise.all([h.claim(b!), h.claim(c!)]);
      if (grants.every(grant => grant === null)) break;
      for (const [index, grant] of grants.entries()) if (grant) {
        await h.send([b!, c!][index]!, 'complete_work', { ...token(grant), result: (grant.item.input as number) ** 2 });
      }
    }
    expect(h.state().workQueue!.items.map(item => item.result)).toEqual(Array.from({ length: 10 }, (_, n) => n * n));
    expect(h.state().workQueue!.claims.filter(claim => claim.status === 'completed')).toHaveLength(10);
    expect(h.state().workQueue!.claims.filter(claim => claim.status === 'expired')).toHaveLength(1);
    await expect(h.call('work_status')).resolves.toMatchObject({ total: 10, completed: 10, pending: 0, claimed: 0 });
    await h.finish(b!); await h.finish(c!);
    h.kernel.finishScript('queue-test', h.state().workflowId, h.state().script!.runId, { text: '{}' });
    expect(h.state().script!.status).toBe('result_ready');
    expect(await h.command('work item-0')).toContain('版本 1：expired');
    expect(await h.command('status')).toContain('工作队列：10 项');
  });

  it('deduplicates claim/progress/completion operations but never revives a finished grant', async () => {
    const h = harness(); await h.start(); await h.work('enqueue', { key: 'work', title: 'Work' });
    await h.create('A'); await h.run(1); const request = h.requests[0]!;
    const grant = (await h.claim(request, { operationId: 'claim', leaseMs: 3000 }))!;
    expect((await h.claim(request, { operationId: 'claim', leaseMs: 3000 }))!.claimId).toBe(grant.claimId);
    expect((await h.claim(request))!.claimId).toBe(grant.claimId);
    const progress = { operationId: 'progress', ...token(grant), expectedProgressVersion: 0, state: { next: 'finish' } };
    await h.send(request, 'checkpoint_work', progress);
    await h.send(request, 'checkpoint_work', progress);
    expect(h.state().workQueue!.items[0]!.progress.version).toBe(1);
    await expect(h.send(request, 'checkpoint_work', { ...progress, state: 'different' })).rejects.toThrow('operationId conflict');
    await expect(h.send(request, 'checkpoint_work', { ...progress, operationId: 'old-version' })).rejects.toThrow('progressVersion conflict');
    h.advance(1000);
    const renew = { operationId: 'renew', ...token(grant), leaseMs: 5000 };
    const extended = await h.send(request, 'renew_claim', renew);
    h.advance(1000);
    expect(await h.send(request, 'renew_claim', renew)).toEqual(extended);
    expect(await h.send(request, 'renew_claim', { ...renew, operationId: 'short-renewal', leaseMs: 1000 })).toEqual(extended);
    const done = { operationId: 'done', ...token(grant), result: { answer: 42 } };
    await h.send(request, 'complete_work', done); await h.send(request, 'complete_work', done);
    expect(h.state().workQueue!.claims).toHaveLength(1);
    await expect(h.claim(request, { operationId: 'claim', leaseMs: 3000 })).rejects.toThrow('stale');
    await expect(h.send(request, 'complete_work', { ...done, operationId: 'late', result: 'overwrite' })).rejects.toThrow('stale');
    expect(h.state().workQueue!.items[0]!.result).toEqual({ answer: 42 });
  });

  it('serializes shared worktree resources and releases unfinished work when a member exits', async () => {
    const h = harness(); await h.start();
    await h.work('enqueue', { key: 'one', title: 'Edit one', resources: ['worktree:shared'] });
    await h.work('enqueue', { key: 'two', title: 'Edit two', resources: ['worktree:shared'] });
    await h.work('enqueue', { key: 'other', title: 'Other', resources: ['worktree:other'] });
    for (const member of ['A', 'B', 'C']) await h.create(member); await h.run(3);
    const [a, b, c] = h.requests;
    expect((await h.claim(a!))!.item.key).toBe('one');
    const independent = (await h.claim(b!))!;
    expect(independent.item.key).toBe('other');
    expect(await h.claim(c!)).toBeNull();
    await h.finish(a!);
    expect(h.state().workQueue!.items[0]!.status).toBe('pending');
    const adopted = (await h.claim(c!))!;
    expect(adopted.item.key).toBe('one');
    await h.send(c!, 'complete_work', { ...token(adopted), result: 'done' });
    expect((await h.claim(c!))!.item.key).toBe('two');
  });

  it('preserves item progress across pause/restart and requires explicit replay before consuming again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-queue-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const h = harness(join(directory, 'state.sqlite')); await h.start();
    await h.work('enqueue', { key: 'work', title: 'Work', input: { original: true } });
    await h.create('A'); await h.run(1); const old = h.requests[0]!;
    const grant = (await h.claim(old))!;
    await h.send(old, 'checkpoint_work', { ...token(grant), expectedProgressVersion: 0, state: { next: 'publish' } });
    await h.call('pause'); await h.settle(old); await h.restart();
    expect(h.state().status).toBe('interrupted');
    await h.kernel.tick(); expect(h.requests).toHaveLength(1);
    await expect(h.work('status')).rejects.toThrow('inactive');
    await h.call('enqueue_work', { key: 'new', title: 'New work queued while interrupted' });
    await h.kernel.tick(); expect(h.requests).toHaveLength(1);
    await h.call('replay_script'); h.begin();
    await h.work('enqueue', { key: 'work', title: 'Work', input: { original: true } });
    expect(h.state().workQueue!.items).toHaveLength(2);
    await h.create('A'); await h.run(2);
    const recovered = (await h.claim(h.requests[1]!))!;
    expect(recovered.item.progress).toMatchObject({ version: 1, state: { next: 'publish' } });
    expect(recovered.generation).toBe(2);
    await expect(h.send(old, 'complete_work', { ...token(grant), result: 'late' })).rejects.toThrow('inactive');
  });

  it('revokes a persisted orphan claim on startup even when its lease has not expired', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-orphan-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const h = harness(); await h.start(); await h.work('enqueue', { key: 'work', title: 'Work' });
    await h.create('A'); await h.run(1); const grant = (await h.claim(h.requests[0]!))!;
    await h.send(h.requests[0]!, 'checkpoint_work', { ...token(grant), expectedProgressVersion: 0, state: 'durable' });
    const snapshot = h.state();
    const path = join(directory, 'snapshot.sqlite'); const db = new Database(path);
    db.exec('CREATE TABLE workflows (id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)');
    db.prepare('INSERT INTO workflows VALUES (?, ?, ?, ?)').run(snapshot.workflowId, 'queue-test', snapshot.status, JSON.stringify(snapshot));
    db.close();
    const restored = harness(path);
    expect(restored.state().status).toBe('interrupted');
    expect(restored.state().workQueue!.items[0]).toMatchObject({ status: 'pending', progress: { version: 1, state: 'durable' } });
    expect(restored.state().workQueue!.claims[0]).toMatchObject({ status: 'cancelled', reason: expect.stringContaining('restarted') });
  });

  it('bounds retries, retains progress and requires explicit retry for terminal failures', async () => {
    const h = harness(); await h.start(); await h.work('enqueue', { key: 'work', title: 'Work', maxAttempts: 1 });
    await h.create('A'); await h.run(1); const request = h.requests[0]!;
    const first = (await h.claim(request))!;
    await h.send(request, 'checkpoint_work', { ...token(first), expectedProgressVersion: 0, state: 'resume-here' });
    await h.send(request, 'fail_work', { ...token(first), error: 'temporary', retry: true });
    expect(await h.claim(request)).toBeNull();
    expect(h.state().workQueue!.items[0]!.status).toBe('failed');
    await h.call('retry_work', { itemId: first.item.id });
    const second = (await h.claim(request))!;
    expect(second.generation).toBe(2); expect(second.item.progress.state).toBe('resume-here');
    await h.send(request, 'complete_work', { ...token(second), result: true });
    await expect(h.call('retry_work', { itemId: first.item.id })).rejects.toThrow('Only failed');
  });

  it('does not treat an early script return as completion and cancels the queue explicitly', async () => {
    const h = harness(); await h.start(); await h.work('enqueue', { key: 'work', title: 'Work' });
    h.kernel.finishScript('queue-test', h.state().workflowId, h.state().script!.runId, { text: '{}' });
    expect(h.state().script).toMatchObject({ status: 'failed', error: expect.stringContaining('unfinished work') });
    await expect(h.call('complete', { reportRef: 'unused', openIssues: [], verificationLimits: 'test' })).rejects.toThrow('unfinished');
    await h.call('cancel');
    const last = h.kernel.latest('queue-test')!;
    expect(last.workQueue!.items[0]!.status).toBe('cancelled');
    expect(await h.command('work work')).toContain('cancelled');
  });

  it('cancels an active last-attempt claim without misreporting budget exhaustion as failure', async () => {
    const h = harness(); await h.start();
    await h.work('enqueue', { key: 'last', title: 'Last attempt', maxAttempts: 1 });
    await h.create('A'); await h.run(1); await h.claim(h.requests[0]!);
    const id = h.state().workflowId;
    await h.call('cancel');
    const last = h.kernel.state('queue-test', id)!;
    expect(last.workQueue!.items[0]!.status).toBe('cancelled');
    expect(last.workQueue!.claims[0]!.status).toBe('cancelled');
  });

  it('validates ownership, input limits, immutable keys and authorization without mutating state on failure', async () => {
    const h = harness(); await h.start();
    await h.work('enqueue', { key: 'work', title: 'Work' });
    await expect(h.work('enqueue', { key: 'work', title: 'Changed' })).rejects.toThrow('Duplicate');
    await expect(h.call('enqueue_work', { key: 'work', title: 'Changed' })).rejects.toThrow('conflict');
    await expect(h.create('A', 'work')).rejects.toThrow('Duplicate');
    await expect(h.work('enqueue', { key: 'large', title: 'Large', input: 'x'.repeat(16001) })).rejects.toThrow('exceeds');
    await h.create(undefined, 'one-shot'); await h.create('A'); await h.run(2);
    await expect(h.claim(h.requests[0]!)).rejects.toThrow('persistent member');
    const request = h.requests[1]!;
    await expect(h.claim(request, { member: 'somebody-else' })).rejects.toThrow('Unsupported');
    await expect(h.claim(request, { leaseMs: 999 })).rejects.toThrow('integer');
    const grant = (await h.claim(request))!;
    await expect(h.send(request, 'complete_work', token(grant))).rejects.toThrow('requires result');
    await expect(h.send(request, 'checkpoint_work', { ...token(grant), expectedProgressVersion: 0, state: 'x'.repeat(16001) })).rejects.toThrow('exceeds');
    expect(h.state().workQueue!.items[0]!.progress.version).toBe(0);
    h.changeRoot();
    await expect(h.send(request, 'complete_work', { ...token(grant), result: 'unauthorized' })).rejects.toThrow('root binding changed');
    expect(h.state().workQueue!.items[0]!.status).toBe('claimed');
  });

  it('paginates summaries and keeps work payloads out of status and Lark views', async () => {
    const h = harness(); await h.start();
    for (let i = 0; i < 25; i++) await h.work('enqueue', { key: 'work-' + i, title: 'Work', input: 'private-input' });
    const before = h.state().stateVersion;
    const page = await h.call('work_status');
    expect(page).toMatchObject({ total: 25, offset: 0, nextOffset: 16 });
    expect(JSON.stringify(page)).not.toContain('private-input');
    await expect(h.call('work_status', { offset: 16, limit: 10 })).resolves.toMatchObject({ nextOffset: null });
    expect(h.state().stateVersion).toBe(before);
    const display = await h.command('work');
    expect(display).toContain('25 项'); expect(display).not.toContain('private-input');
    expect(display!.length).toBeLessThan(8000);
    await expect(h.call('work_status', { itemId: h.state().workQueue!.items[0]!.id })).resolves.toMatchObject({ input: 'private-input' });
  });
});
