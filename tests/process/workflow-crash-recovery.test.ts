import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { childInput, crashHarness, itemInput } from '../helpers/workflow-crash-controller';
import type { CrashBarrier } from '../helpers/workflow-crash-controller';
import type { WorkflowState, WorkflowWorkItem } from '../../src/workflows/types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe.skipIf(process.platform === 'win32')('workflow recovery after controller SIGKILL', () => {
  let bundleDir: string;
  beforeAll(async () => {
    bundleDir = await mkdtemp(join(tmpdir(), 'workflow-crash-bundle-'));
    await symlink(resolve('node_modules'), join(bundleDir, 'node_modules'), 'dir');
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsup/package.json'))('esbuild');
    await build({ entryPoints: [resolve('tests/helpers/workflow-crash-controller.ts')], bundle: true,
      packages: 'external', platform: 'node', format: 'esm', outfile: join(bundleDir, 'controller.mjs') });
  });
  afterAll(async () => { if (bundleDir) await rm(bundleDir, { recursive: true, force: true }); });

  async function crash(boundary: string) {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-crash-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const child = spawn(process.execPath, [join(bundleDir, 'controller.mjs'), '--workflow-crash-child', directory, boundary],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const exited = once(child, 'exit');
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    let barrier!: CrashBarrier;
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw new Error('Controller failed: ' + stderr);
      barrier = JSON.parse(await readFile(join(directory, 'barrier.json'), 'utf8'));
    }, { timeout: 10_000 });
    expect(barrier.pid).toBe(child.pid);
    expect(barrier.pid).not.toBe(process.pid);
    expect(barrier.boundary).toBe(boundary);
    expect(barrier.inTransaction).toBe(boundary.endsWith('-uncommitted'));
    expect((await stat(join(directory, 'state.sqlite-wal'))).size).toBeGreaterThan(0);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await exited).toEqual([null, 'SIGKILL']);
    const path = join(directory, 'state.sqlite');
    const db = new Database(path);
    let persisted: WorkflowState[];
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      persisted = (db.prepare('SELECT data FROM workflows').all() as Array<{ data: string }>).map(row => JSON.parse(row.data));
    } finally { db.close(); }
    const h = crashHarness(path);
    cleanup.push(() => h.kernel.close());
    expect(h.state().status).toBe('interrupted');
    await h.kernel.tick();
    expect(h.requests).toHaveLength(0);
    expect(h.kernel.queuedScripts()).toHaveLength(0);
    return { h, barrier, persisted };
  }

  it.each(['before-yield', 'result-committed', 'child-finish-uncommitted'])(
    'recovers %s without duplicating a child or losing the parent conversation', async boundary => {
      const { h, barrier, persisted } = await crash(boundary);
      const childId = barrier.child!.workflowId;
      expect(persisted).toHaveLength(2);
      const priorChild = persisted.find(state => state.workflowId === childId)!;
      expect(priorChild.status).toBe(boundary === 'result-committed' ? 'completed' : 'active');
      if (boundary === 'child-finish-uncommitted') {
        expect(priorChild.script!.resultRef).toBeUndefined();
        expect(h.state().tasks[0]!.waitingWorkflowId).toBe(childId);
      }
      await h.replay(); await h.agent();
      if (boundary !== 'result-committed') {
        await h.kernel.tick(); expect(h.requests).toHaveLength(0);
        expect(h.state().tasks[0]!.status).toBe('waiting_workflow');
        h.begin(childId); h.finishScript(childId);
      }
      await h.run(1);
      const resumed = h.requests[0]!;
      expect(resumed.task.taskId).toBe(barrier.request.task.taskId);
      expect(resumed.attemptId).not.toBe(barrier.request.attemptId);
      expect(resumed.session.nativeSessionId).toBe(barrier.root.sessions[0]!.nativeSessionId);
      await expect(h.send(barrier.request, 'run_workflow', childInput)).rejects.toThrow('inactive');
      await expect(h.send(resumed, 'read_context')).resolves.toMatchObject({ workflows: {
        checkpoint: childInput.checkpoint, call: { workflowId: childId, result: 42 } } });
      for (let i = 0; i < 2; i++) await expect(h.send(resumed, 'run_workflow', childInput))
        .resolves.toMatchObject({ workflowId: childId, status: 'completed', result: 42 });
      expect((await h.call('status') as { children: unknown[] }).children).toHaveLength(1);
      expect(h.state(childId).script!.revision).toBe(boundary === 'result-committed' ? 0 : 1);
      expect(h.state(childId).artifacts.filter(a => a.kind === 'workflow-result')).toHaveLength(1);
      await h.finish(resumed); h.finishScript(h.state().workflowId);
      expect(h.state().events.map(event => event.kind)).toEqual(['script_result_ready']);
      expect(h.state().tasks).toHaveLength(1);
    }, 15_000);

  it('rolls back an uncommitted child insertion and allows the same operation to be retried', async () => {
    const { h, barrier, persisted } = await crash('child-insert-uncommitted');
    expect(barrier.child).toBeDefined();
    expect(persisted).toHaveLength(1);
    expect(h.state(barrier.child!.workflowId)).toBeUndefined();
    expect(h.state().tasks[0]!.waitingWorkflowId).toBeUndefined();
    await h.replay(); await h.agent(); await h.run(1);
    const resumed = h.requests[0]!;
    expect(resumed.session.nativeSessionId).toBe(barrier.root.sessions[0]!.nativeSessionId);
    const child = await h.send(resumed, 'run_workflow', childInput) as { workflowId: string };
    await expect(h.send(resumed, 'run_workflow', childInput)).resolves.toEqual(child);
    expect((await h.call('status') as { children: unknown[] }).children).toHaveLength(1);
    await h.finish(resumed); h.begin(child.workflowId); h.finishScript(child.workflowId);
    await h.run(2); await h.finish(h.requests[1]!); h.finishScript(h.state().workflowId);
    expect(h.state().script!.status).toBe('result_ready');
  }, 15_000);

  it.each(['work-claimed', 'work-completed'])('recovers %s and fences stale claims and attempts', async boundary => {
    const { h, barrier, persisted } = await crash(boundary);
    const completed = boundary === 'work-completed';
    const oldClaim = barrier.root.workQueue!.claims[0]!;
    const oldToken = { claimId: oldClaim.id, generation: oldClaim.generation };
    expect(oldClaim.leaseUntil).toBeGreaterThan(Date.now());
    expect(persisted[0]!.workQueue!.items[0]!.status).toBe(completed ? 'completed' : 'claimed');
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: completed ? 'completed' : 'pending',
      progress: { version: 1, state: { next: 'publish', partial: 49 } } });
    expect(h.state().workQueue!.claims[0]!.status).toBe(completed ? 'completed' : 'cancelled');
    await h.replay(); await h.work('enqueue', itemInput); await h.agent(true); await h.run(1);
    expect(h.state().workQueue!.items).toHaveLength(1);
    const resumed = h.requests[0]!;
    expect(resumed.session.nativeSessionId).toBe(barrier.root.sessions[0]!.nativeSessionId);
    await expect(h.send(barrier.request, 'complete_work', { ...oldToken, result: 'late' })).rejects.toThrow('inactive');
    await expect(h.send(resumed, 'complete_work', { ...oldToken, result: 'late' })).rejects.toThrow('stale');
    if (completed) {
      expect(await h.send(resumed, 'claim_work')).toBeNull();
    } else {
      const grant = await h.send(resumed, 'claim_work') as { claimId: string; generation: number; item: WorkflowWorkItem };
      expect(grant.claimId).not.toBe(oldClaim.id);
      expect(grant.generation).toBe(2);
      expect(grant.item.id).toBe(barrier.root.workQueue!.items[0]!.id);
      expect(grant.item.progress.state).toEqual({ next: 'publish', partial: 49 });
      await h.send(resumed, 'complete_work', { claimId: grant.claimId, generation: grant.generation, result: 49 });
    }
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed', result: 49, generation: completed ? 1 : 2 });
    expect(h.state().workQueue!.claims.filter(claim => claim.status === 'completed')).toHaveLength(1);
    await h.finish(resumed); h.finishScript(h.state().workflowId);
    expect(h.state().script!.status).toBe('result_ready');
  }, 15_000);
});
