import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import { replaceWorkflowState } from '../src/engine/kernel-store';
import { handleWorkflowCommand } from '../src/chat/commands';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult, WorkflowWorkItem } from '../src/engine/types';

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
  it('lets three members consume ten items, keeping the claim of a running member past its lease, reclaiming progress when its turn ends and rejecting late results', async () => {
    const h = harness(); await h.start();
    for (let n = 0; n < 10; n++) await h.work('enqueue', { key: 'item-' + n, title: 'Compute ' + n, input: n });
    for (const member of ['A', 'B', 'C']) await h.create(member);
    await h.run(3);
    const [a, b, c] = h.requests;
    const initial = await Promise.all(h.requests.map((request, i) => h.claim(request, { leaseMs: i === 0 ? 1000 : 120_000 })));
    expect(new Set(initial.map(grant => grant!.item.id)).size).toBe(3);
    const first = initial[0]!;
    await h.send(a!, 'checkpoint_work', { ...token(first), expectedProgressVersion: 0, state: { prepared: 'partial-work' } });
    // The short lease runs out while the member's turn is still running: the engine keeps the claim for it.
    h.advance(600_000); await h.kernel.tick();
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'claimed' });
    expect(h.state().tasks.find(task => task.taskId === a!.task.taskId)!.status).toBe('running');
    // The turn then ends without completing the item: the claim returns to the queue with the saved progress.
    await h.finish(a!);
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
    expect(h.state().workQueue!.claims.filter(claim => claim.status === 'expired')).toHaveLength(0);
    expect(h.state().workQueue!.claims.filter(claim => claim.status === 'cancelled')).toHaveLength(1);
    await expect(h.call('work_status')).resolves.toMatchObject({ total: 10, completed: 10, pending: 0, claimed: 0 });
    await h.finish(b!); await h.finish(c!);
    h.kernel.finishScript('queue-test', h.state().workflowId, h.state().script!.runId, { text: '{}' });
    expect(h.state().script!.status).toBe('result_ready');
    expect(await h.command('work item-0')).toContain('版本 1：cancelled');
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
    // Leases are the engine's business: members have no renewal to call.
    await expect(h.send(request, 'renew_claim', { ...token(grant), leaseMs: 5000 })).rejects.toThrow('not permitted');
    const done = { operationId: 'done', ...token(grant), result: { answer: 42 } };
    await h.send(request, 'complete_work', done); await h.send(request, 'complete_work', done);
    expect(h.state().workQueue!.claims).toHaveLength(1);
    await expect(h.claim(request, { operationId: 'claim', leaseMs: 3000 })).rejects.toThrow('stale');
    await expect(h.send(request, 'complete_work', { ...done, operationId: 'late', result: 'overwrite' })).rejects.toThrow('stale');
    expect(h.state().workQueue!.items[0]!.result).toEqual({ answer: 42 });
  });

  it('extends the deadline of a running workflow, within bounds', async () => {
    const h = harness(); await h.start();
    const original = h.state().deadlineAt;
    await expect(h.call('extend_deadline', { minutes: 0 })).rejects.toThrow('integer');
    await expect(h.call('extend_deadline', { minutes: 10_080 })).resolves.toMatchObject({ deadlineAt: original + 10_080 * 60_000 });
    await expect(h.call('extend_deadline', { minutes: 10_080 })).rejects.toThrow('14 days');
    // Past the original deadline the workflow is still running; past the new one it fails.
    h.advance(original - 1_000_000 + 60_000); await h.kernel.tick();
    expect(h.state()).toMatchObject({ status: 'active', script: { status: 'running' } });
    h.advance(10_080 * 60_000); await h.kernel.tick();
    expect(h.state().script).toMatchObject({ status: 'failed', error: expect.stringContaining('deadline') });
    await expect(h.call('extend_deadline', { minutes: 60 })).rejects.toThrow('deadline');
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
    cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
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

  /** A workflow whose member A holds a claim with saved progress, restored into a new controller as after a crash. */
  async function crashed(before?: (h: ReturnType<typeof harness>, grant: Grant) => Promise<unknown>) {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-held-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const h = harness(); await h.start(); await h.work('enqueue', { key: 'work', title: 'Work' });
    await h.create('A'); await h.run(1); const old = h.requests[0]!; const grant = (await h.claim(old))!;
    await h.send(old, 'checkpoint_work', { ...token(grant), operationId: 'save-1', expectedProgressVersion: 0, state: 'durable' });
    await before?.(h, grant);
    const path = join(directory, 'snapshot.sqlite');
    replaceWorkflowState(path, h.state());
    return { restored: harness(path), old, grant };
  }
  const resume = async (h: ReturnType<typeof harness>) => { expect(await h.kernel.resumeAfterRestart()).toMatchObject([{ resumed: true }]); h.begin(); };

  it('keeps a claim for its member across a restart and hands it to the member\'s next attempt', async () => {
    const { restored, old, grant } = await crashed();
    expect(restored.state().status).toBe('interrupted');
    expect(restored.state().workQueue!.items[0]).toMatchObject({ status: 'claimed', generation: 1, progress: { version: 1, state: 'durable' } });
    expect(restored.state().workQueue!.claims[0]).toMatchObject({ id: grant.claimId, status: 'active', heldUntil: 1_000_000 + 10 * 60_000 });
    // The lease lapses while nothing runs; a held claim does not expire by it.
    restored.advance(5 * 60_000);
    await resume(restored); await restored.kernel.tick();
    expect(restored.state().workQueue!.claims[0]).toMatchObject({ status: 'active', attemptId: old.attemptId });
    await restored.create('A'); await restored.run(1);
    const next = restored.requests[0]!;
    expect(next.task.taskId).toBe(old.task.taskId);
    expect(next.attemptId).not.toBe(old.attemptId);
    const claim = restored.state().workQueue!.claims[0]!;
    expect(claim).toMatchObject({ id: grant.claimId, generation: 1, status: 'active', taskId: next.task.taskId, attemptId: next.attemptId, leaseUntil: 1_000_000 + 5 * 60_000 + 120_000 });
    expect(claim.heldUntil).toBeUndefined();
    expect(next.prompt).toContain(grant.claimId);
    // The member goes on with the claim ID and generation it had; claiming again answers with the same claim.
    expect(await restored.claim(next)).toMatchObject({ claimId: grant.claimId, generation: 1 });
    // A call whose answer was lost with the old controller is answered from its record, not applied again.
    await expect(restored.send(next, 'checkpoint_work', { ...token(grant), operationId: 'save-1', expectedProgressVersion: 0, state: 'durable' }))
      .resolves.toMatchObject({ progressVersion: 1 });
    await restored.send(next, 'complete_work', { ...token(grant), result: 'done' });
    expect(restored.state().workQueue!.items[0]).toMatchObject({ status: 'completed', result: 'done', generation: 1 });
    expect(restored.state().workQueue!.claims).toHaveLength(1);
  });

  it('keeps the claim of a turn that a controller shutdown ended', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-shutdown-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const h = harness(join(directory, 'state.sqlite')); await h.start(); await h.work('enqueue', { key: 'work', title: 'Work' });
    await h.create('A'); await h.run(1); const grant = (await h.claim(h.requests[0]!))!;
    await h.restart();
    expect(h.state().tasks[0]!.status).toBe('interrupted');
    expect(h.state().workQueue!.claims[0]).toMatchObject({ id: grant.claimId, status: 'active', heldUntil: expect.any(Number) });
    await resume(h); await h.create('A'); await h.run(2);
    await h.send(h.requests[1]!, 'complete_work', { ...token(grant), result: 'done' });
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed', generation: 1 });
  });

  it('returns a held claim to the queue when its member does not resume in time', async () => {
    const { restored, old, grant } = await crashed();
    const { workflowId } = restored.state();
    // The member's process outlived the old controller.
    restored.kernel.putWorkerHost({ hostKey: 'survivor', workflowId, match: 'turn', taskId: old.task.taskId, agentKind: 'codex', tokenHash: 'token', createdAt: 0 });
    await resume(restored);
    restored.advance(10 * 60_000 - 1); await restored.kernel.tick();
    expect(restored.state().workQueue!.claims[0]!.status).toBe('active');
    expect(restored.kernel.workerHost(workflowId, 'turn')!.discard).toBe(false);
    restored.advance(1); await restored.kernel.tick();
    // It must not go on with a claim that went back to the queue.
    expect(restored.kernel.workerHost(workflowId, 'turn')!.discard).toBe(true);
    expect(restored.state().workQueue!.claims[0]).toMatchObject({ status: 'cancelled', reason: expect.stringContaining('did not resume') });
    expect(restored.state().workQueue!.claims[0]!.heldUntil).toBeUndefined();
    expect(restored.state().workQueue!.items[0]).toMatchObject({ status: 'pending', progress: { version: 1, state: 'durable' } });
    await restored.create('B'); await restored.run(1);
    const taken = (await restored.claim(restored.requests[0]!))!;
    expect(taken.claimId).not.toBe(grant.claimId);
    expect(taken.generation).toBe(2);
  });

  it('keeps waiting for a member whose next turn is queued behind the worker limit', async () => {
    const { restored, grant } = await crashed();
    await resume(restored);
    for (const member of ['B', 'C', 'D', 'E']) await restored.create(member);
    await restored.run(4); await restored.create('A');
    restored.advance(10 * 60_000 + 1); await restored.kernel.tick();
    expect(restored.requests).toHaveLength(4);
    expect(restored.state().workQueue!.claims[0]).toMatchObject({ status: 'active', heldUntil: expect.any(Number) });
    await restored.finish(restored.requests[0]!); await restored.run(5);
    await restored.send(restored.requests[4]!, 'complete_work', { ...token(grant), result: 'done' });
    expect(restored.state().workQueue!.items[0]).toMatchObject({ status: 'completed', generation: 1 });
  });

  it('cancels held claims when the interrupted workflow cannot resume on its own', async () => {
    const { restored } = await crashed();
    restored.changeRoot();
    expect(await restored.kernel.resumeAfterRestart()).toMatchObject([{ resumed: false }]);
    expect(restored.state().workQueue!.claims[0]).toMatchObject({ status: 'cancelled', reason: expect.stringContaining('restarted') });
    expect(restored.state().workQueue!.items[0]).toMatchObject({ status: 'pending', progress: { version: 1, state: 'durable' } });
  });

  it('answers a completion repeated after a restart from its record and still fences other late calls', async () => {
    const done = { operationId: 'finish-1', result: 'done' };
    const { restored, grant } = await crashed((h, held) => h.send(h.requests[0]!, 'complete_work', { ...token(held), ...done }));
    expect(restored.state().workQueue!.claims[0]!.status).toBe('completed');
    await resume(restored); await restored.create('A'); await restored.run(1);
    const next = restored.requests[0]!;
    await expect(restored.send(next, 'complete_work', { ...token(grant), ...done })).resolves.toMatchObject({ status: 'completed', generation: 1 });
    await expect(restored.send(next, 'complete_work', { ...token(grant), operationId: 'finish-1', result: 'other' })).rejects.toThrow('stale');
    await expect(restored.send(next, 'complete_work', { ...token(grant), result: 'done' })).rejects.toThrow('stale');
    expect(restored.state().workQueue!.items[0]).toMatchObject({ status: 'completed', result: 'done' });
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
    await h.call('cancel_workflow');
    const last = h.kernel.latest('queue-test')!;
    expect(last.workQueue!.items[0]!.status).toBe('cancelled');
    expect(await h.command('work work')).toContain('cancelled');
  });

  it('cancels an active last-attempt claim without misreporting budget exhaustion as failure', async () => {
    const h = harness(); await h.start();
    await h.work('enqueue', { key: 'last', title: 'Last attempt', maxAttempts: 1 });
    await h.create('A'); await h.run(1); await h.claim(h.requests[0]!);
    const id = h.state().workflowId;
    await h.call('cancel_workflow');
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

describe('work that is for one member', () => {
  it('hands a member its own items first and sends what follows from an item to the member that completed it', async () => {
    const h = harness(); await h.start();
    await h.work('enqueue', { key: 'first', title: 'First', input: 1 });
    await h.work('enqueue', { key: 'mine', title: 'For B', input: 2, assignee: 'B', priority: -5 });
    for (const member of ['A', 'B']) await h.create(member);
    await h.run(2);
    const [a, b] = h.requests;
    // B is handed the item that is for it although another one has the higher priority.
    const own = (await h.claim(b!))!;
    expect(own.item).toMatchObject({ key: 'mine', assignee: 'B' });
    await h.send(b!, 'complete_work', { ...token(own), result: 'built' });
    expect(h.state().workQueue!.items[1]).toMatchObject({ status: 'completed', doneBy: 'B' });
    // What is found wrong with it goes, by its origin, to the queue it was in and to the member that completed it.
    // Outside a swarm nobody wakes that member, so the item is not kept from the others, and the answer says so.
    const found = await h.send(a!, 'enqueue_work', { key: 'bug', title: 'Mine is wrong', input: { repro: 1 }, origin: 'mine' });
    expect(found).toMatchObject({ key: 'bug', queue: 'default', assignee: 'B', assigneeNote: expect.stringContaining('any member of the queue can claim it') });
    expect(h.state().workQueue!.items[2]).toMatchObject({ key: 'bug', by: 'A', origin: 'mine', assignee: 'B' });
    expect(((await h.claim(b!))!).item.key).toBe('bug');
    expect(((await h.claim(a!))!).item.key).toBe('first');
    await expect(h.send(a!, 'enqueue_work', { key: 'x', title: 'X', input: 0, origin: 'nope' })).rejects.toThrow('origin must be the key of an existing work item');
    await expect(h.call('enqueue_work', { key: 'y', title: 'Y', assignee: 'not a name' })).rejects.toThrow('assignee is the name of a member');
    // The same call answers with the same item whatever its origin resolves to by then; another origin is another item.
    const again = await h.call('enqueue_work', { key: 'z', title: 'Z', origin: 'mine' }) as { itemId: string };
    expect(again).toMatchObject({ key: 'z', queue: 'default', assignee: 'B' });
    expect(await h.call('enqueue_work', { key: 'z', title: 'Z', origin: 'mine' })).toMatchObject({ itemId: again.itemId });
    await expect(h.call('enqueue_work', { key: 'z', title: 'Z', origin: 'first' })).rejects.toThrow('conflict');
    expect(await h.call('update_work', { key: 'z', assignee: 'A' })).toMatchObject({ key: 'z', assignee: 'A' });
    expect(await h.call('update_work', { key: 'z', assignee: null })).not.toHaveProperty('assignee');
    const page = await h.call('work_status') as { items: Array<Record<string, unknown>> };
    expect(page.items.find(item => item.key === 'mine')).toMatchObject({ assignee: 'B', doneBy: 'B' });
    expect(page.items.find(item => item.key === 'bug')).toMatchObject({ origin: 'mine', assignee: 'B', by: 'A' });
    expect(await h.call('search_work', { query: 'mine built' })).toMatchObject({ items: [{ key: 'mine', doneBy: 'B' }] });
  });
});

describe('the paths work items expect to change', () => {
  it('reports the unfinished items whose paths overlap and that nothing orders, without locking anything', async () => {
    const h = harness(); await h.start();
    const add = (key: string, writes?: string[], more: Record<string, unknown> = {}) => h.call('enqueue_work',
      { key, title: 'Change ' + key, input: key, ...(writes ? { writes } : {}), ...more }) as Promise<Record<string, unknown>>;
    const overlapping = (response: unknown) => (((response as Record<string, unknown>).writeOverlaps ?? []) as Array<{ key: string }>).map(entry => entry.key).sort();
    // Paths are compared as they are written down: without ./, repeated or trailing slashes.
    expect(await add('parser', ['./src/parser/', 'docs//parser.md'])).not.toHaveProperty('writeOverlaps');
    expect(h.state().workQueue!.items[0]!.writes).toEqual(['docs/parser.md', 'src/parser']);
    // A file under a directory that another item names overlaps it; a sibling whose name only starts the same does not.
    expect(await add('lexer', ['src/parser/lexer.ts'])).toMatchObject({ writeOverlaps: [{ key: 'parser', queue: 'default', status: 'pending', title: 'Change parser', paths: ['src/parser'] }] });
    expect(overlapping(await add('sibling', ['src/parser-tests']))).toEqual([]);
    expect(overlapping(await add('unrelated'))).toEqual([]);
    expect(h.state().workQueue!.items.at(-1)).not.toHaveProperty('writes');
    // What a dependency orders, directly or through another item, and what a shared resource key serializes is not reported.
    expect(overlapping(await add('after', ['src/parser'], { dependsOn: ['parser'] }))).toEqual(['lexer']);
    expect(overlapping(await add('later', ['docs/parser.md'], { dependsOn: ['after'] }))).toEqual([]);
    expect(overlapping(await add('locked', ['src/parser/ast.ts'], { resources: ['worktree:parser'] }))).toEqual(['after', 'parser']);
    expect(overlapping(await add('locked-too', ['src/parser/ast.ts'], { resources: ['worktree:parser'] }))).toEqual(['after', 'parser']);
    // The whole tree overlaps every relative path and no absolute one.
    await add('data', ['/data/corpus']);
    expect(overlapping(await add('sweep', ['.']))).toEqual(['after', 'later', 'lexer', 'locked', 'locked-too', 'parser', 'sibling']);

    // Nothing is locked: two members take overlapping items at once, and each is told who else is in its files, the ones at work first.
    await add('urgent', ['src/parser/lexer.ts'], { priority: 10 });
    for (const member of ['A', 'B']) await h.create(member);
    await h.run(2);
    const [a, b] = h.requests;
    const first = (await h.claim(a!))!;
    expect(first.item.key).toBe('urgent');
    expect(overlapping(first.item)).toEqual(['after', 'lexer', 'parser', 'sweep']);
    const second = (await h.claim(b!))!;
    expect(second.item.key).toBe('parser');
    expect((second.item as unknown as { writeOverlaps: unknown[] }).writeOverlaps[0]).toMatchObject({ key: 'urgent', status: 'claimed', member: 'A', paths: ['src/parser/lexer.ts'] });
    expect(overlapping(second.item)).toEqual(['lexer', 'locked', 'locked-too', 'sweep', 'urgent']);
    // An item that is done is in nobody's way.
    await h.send(a!, 'complete_work', { ...token(first), result: 'done' });
    expect(overlapping(await h.call('work_status', { key: 'lexer' }))).toEqual(['after', 'parser', 'sweep']);
    expect(await h.call('work_status', { key: 'urgent' })).not.toHaveProperty('writeOverlaps');

    // A long list is cut, with the number left out.
    for (let n = 0; n < 9; n++) await add('big-' + n, ['/big/' + n]);
    const big = await add('big', ['/big']);
    expect(big.writeOverlaps).toHaveLength(8);
    expect(big.moreWriteOverlaps).toBe(1);
    // The script's own call answers with the item alone, so that a replay reads what the first run read.
    expect(await h.work('enqueue', { key: 'scripted', title: 'Scripted', input: 0, writes: ['src/parser'] })).toEqual({ itemId: expect.any(String), key: 'scripted' });
    expect(overlapping(await h.call('work_status', { key: 'scripted' }))).toContain('lexer');

    const before = h.state().stateVersion;
    await expect(add('escape', ['../other'])).rejects.toThrow('must not contain ..');
    await expect(add('blank', [' src'])).rejects.toThrow('surrounding whitespace');
    await expect(add('many', Array.from({ length: 17 }, (_, n) => 'dir' + n))).rejects.toThrow('at most 16 paths');
    await expect(add('scalar', [], { writes: 'src' })).rejects.toThrow('at most 16 paths');
    // Like the rest of an item, its paths cannot change under the same key.
    await expect(add('parser', ['src/other'])).rejects.toThrow('Work key conflict');
    expect(h.state().stateVersion).toBe(before);
  });
});
