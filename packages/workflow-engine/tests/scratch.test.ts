import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, WorkflowRuntime, type WorkerRunSpec, type WorkflowRoot } from '../src';
import { silentLogger } from '../src/engine/ports';
import { SCRATCH_ENV, scratchSlot, scratchSlots, WorkflowScratch } from '../src/engine/scratch';
import type { WorkflowView } from '../src/engine/types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function scratchRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-scratch-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
}
const gone = (path: string) => vi.waitFor(() => expect(existsSync(path)).toBe(false), { timeout: 10_000, interval: 10 });

describe('scratch directories', () => {
  it('hands a session a private temporary directory and keeps it only while it holds something', async () => {
    const root = await scratchRoot(), scratch = new WorkflowScratch(root, 'store', silentLogger);
    const workflowId = randomUUID(), slot = scratchSlot(randomUUID(), 'builder');
    const lease = await scratch.acquire(workflowId, slot);
    expect(basename(lease.path)).toBe(slot);
    expect(lease.path.startsWith(root)).toBe(true);
    expect(lease.env).toEqual({ TMPDIR: lease.path, TMP: lease.path, TEMP: lease.path, [SCRATCH_ENV]: lease.path });
    expect(existsSync(lease.path)).toBe(true);
    // Short enough for a Unix socket under it, whatever the member is called.
    expect(join('/tmp/lark-wf-scratch', lease.path.slice(root.length), 'x'.repeat(24)).length).toBeLessThan(100);
    // An unused directory does not outlive the turn, and takes its empty parents with it.
    lease.release(); lease.release();
    await gone(dirname(dirname(lease.path)));

    // One with files stays for the member's next turn, which gets the same path.
    const first = await scratch.acquire(workflowId, slot);
    await writeFile(join(first.path, 'cache'), 'kept');
    first.release();
    const second = await scratch.acquire(workflowId, slot);
    expect(second.path).toBe(first.path);
    expect(readdirSync(second.path)).toEqual(['cache']);
    // A worker process that outlives the turn keeps even an empty directory.
    await rm(join(second.path, 'cache'));
    second.release({ running: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(existsSync(second.path)).toBe(true);
    // A finished one-shot worker's goes at once, contents and all.
    const third = await scratch.acquire(workflowId, slot);
    await mkdir(join(third.path, 'target/debug'), { recursive: true }); await writeFile(join(third.path, 'target/debug/bin'), 'x');
    third.release({ remove: true });
    await gone(third.path);
  });

  it('reclaims what finished workflows, retired members and unknown owners left, and nothing that is in use', async () => {
    const root = await scratchRoot(), scratch = new WorkflowScratch(root, 'store', silentLogger);
    const running = randomUUID(), finished = randomUUID(), unreadable = randomUUID();
    const fill = async (workflowId: string, slot: string) => {
      const lease = await scratch.acquire(workflowId, slot);
      await writeFile(join(lease.path, 'file'), 'x'); lease.release();
      return lease.path;
    };
    const kept = await fill(running, 'kept-1'), retired = await fill(running, 'retired-1');
    const done = await fill(finished, 'member-1'), unknown = await fill(unreadable, 'member-1');
    const busy = await scratch.acquire(finished, 'busy-1'); await writeFile(join(busy.path, 'file'), 'x');
    const stray = join(dirname(dirname(kept)), 'left-by-a-crash'); await mkdir(stray);

    await scratch.reclaim(new Map([[running, new Set(['kept-1'])], [unreadable, undefined]]));
    expect([kept, unknown, busy.path].map(existsSync)).toEqual([true, true, true]);
    expect([retired, stray].map(existsSync)).toEqual([false, false]);
    // The finished workflow's directory holds a turn that is still running, so it waits for the next pass.
    expect(existsSync(done)).toBe(true);
    busy.release();
    await scratch.reclaim(new Map([[running, new Set(['kept-1'])], [unreadable, undefined]]));
    expect([done, busy.path].map(existsSync)).toEqual([false, false]);

    // A turn that starts while its directory is being deleted waits for that, and begins in an empty one.
    const old = await scratch.acquire(running, 'retired-1'); await writeFile(join(old.path, 'file'), 'x');
    old.release({ remove: true });
    const lease = await scratch.acquire(running, 'retired-1');
    expect(lease.path).toBe(old.path);
    expect(await readdir(lease.path)).toEqual([]);
    // One that is already running when a pass comes keeps its files.
    await writeFile(join(lease.path, 'file'), 'x');
    await scratch.reclaim(new Map([[running, new Set(['kept-1'])]]));
    expect(await readdir(lease.path)).toEqual(['file']);
    lease.release();
  });

  it('keeps apart the runtimes that share a root', async () => {
    const root = await scratchRoot();
    const one = new WorkflowScratch(root, '/state/a/workflows.sqlite', silentLogger), two = new WorkflowScratch(root, '/state/b/workflows.sqlite', silentLogger);
    const workflowId = randomUUID();
    const mine = await one.acquire(workflowId, 'member-1'), theirs = await two.acquire(workflowId, 'member-1');
    expect(mine.path).not.toBe(theirs.path);
    await writeFile(join(theirs.path, 'file'), 'x'); theirs.release();
    await one.reclaim(new Map());
    expect(existsSync(theirs.path)).toBe(true);
    mine.release();
  });

  it('counts a directory as owned while its member is staffed or its task may still run', () => {
    const session = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
    const task = (n: number, status: string) => ({ taskId: 't' + n, sessionRef: session(n), status });
    const state = {
      agents: [{ agentId: 'a1', key: 'worker', sessionRef: session(1) }, { agentId: 'a2', key: 'gone', sessionRef: session(2) },
        { agentId: 'a3', key: 'leaving', sessionRef: session(3) }, { agentId: 'a4', key: 'solo member', sessionRef: session(4) }],
      swarms: [{ members: [{ name: 'worker' }, { name: 'gone', stopped: 'retired' }, { name: 'leaving', stopped: 'retired' }, { name: 'failed', stopped: 'failed' }] }],
      tasks: [task(3, 'running'), task(5, 'running'), task(6, 'failed'), task(7, 'waiting_input'), task(8, 'result_ready'), task(9, 'cancelled')],
    } as unknown as WorkflowView;
    expect([...scratchSlots(state)].sort()).toEqual([
      // A retired member keeps its directory until the turn it is in has ended.
      'leaving-00000003', 'solo_member-00000004', 'task-00000005', 'task-00000006', 'task-00000007', 'worker-00000001']);
    expect(scratchSlot(session(1), '../../etc')).toBe('_./.._etc-00000001'.replace(/\//g, '_'));
    expect(scratchSlot(session(1), '')).toBe('member-00000001');
  });
});

describe('workers run in their scratch directory', () => {
  it('gives every worker its own TMPDIR, keeps a member\'s across turns and deletes each when its owner is done', async () => {
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo',
      policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} };
    const dir = await scratchRoot();
    const turns: Array<{ prompt: string; scratch: string; seen: string[]; systemPrompt: string }> = [];
    const runtime = new WorkflowRuntime({
      path: ':memory:', scratchRoot: dir, resolveRoot: async () => root, wakeMain: async () => {},
      runner: {
        async start(spec: WorkerRunSpec) {
          await spec.validateBeforeRun();
          const scratch = spec.env.TMPDIR!;
          turns.push({ prompt: spec.prompt, scratch, seen: readdirSync(scratch), systemPrompt: spec.systemPrompt });
          writeFileSync(join(scratch, `out-${turns.length}`), 'x');
          return {
            runId: `run-${turns.length}`, result: Promise.resolve('completed' as const),
            stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
            async *events() {
              yield { type: 'session' as const, nativeSessionId: spec.resume?.id ?? `native-${turns.length}` };
              yield { type: 'final_text' as const, text: 'ok' };
              yield { type: 'done' as const, normal: true };
            },
          };
        },
      },
    });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'scratch', plan: 'A one-shot worker, then one member twice.',
      script: 'await agent("one-shot", {key:"a"}); await agent("first", {key:"b", member:"builder"}); await agent("second", {key:"c", member:"builder"}); return 1;' }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script).toMatchObject({ status: 'result_ready' }); });
    const turn = (prompt: string) => turns.find(entry => entry.prompt.includes(prompt))!;
    const oneShot = turn('one-shot'), first = turn('first'), second = turn('second');
    expect(turns).toHaveLength(3);
    expect(oneShot.scratch.startsWith(dir)).toBe(true);
    expect(basename(oneShot.scratch)).toMatch(/^task-[0-9a-f]{8}$/);
    expect(basename(first.scratch)).toMatch(/^builder-[0-9a-f]{8}$/);
    expect(oneShot.systemPrompt).toContain(`Scratch directory: ${oneShot.scratch}`);
    // The member's second turn finds what its first left; nobody sees another worker's files.
    expect(second.scratch).toBe(first.scratch);
    expect([oneShot.seen, first.seen, second.seen]).toEqual([[], [], ['out-2']]);
    // The one-shot worker's directory went with its turn; the member's stays while the workflow may wake it.
    await gone(oneShot.scratch);
    const sweep = async () => { (runtime as unknown as { scratchReclaimedAt: number }).scratchReclaimedAt = 0; await runtime.tick(); };
    await sweep(); await new Promise(resolve => setTimeout(resolve, 100));
    expect(readdirSync(first.scratch).sort()).toEqual(['out-2', 'out-3']);
    // When the workflow is over, so is everything it held.
    const state = runtime.kernel.state(root.scopeId)!;
    await runtime.kernel.call({ kind: 'main', scopeId: root.scopeId }, 'cancel_workflow', { operationId: randomUUID(), workflowId: state.workflowId, expectedStateVersion: state.stateVersion });
    await vi.waitFor(async () => { await sweep(); expect(existsSync(first.scratch)).toBe(false); }, { timeout: 10_000, interval: 20 });
    await vi.waitFor(async () => expect(await readdir(dir)).toEqual([]), { timeout: 10_000, interval: 20 });
  }, 30_000);

  it('leaves workers on the shared temporary directory when the host configures no scratch root', async () => {
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: '/repo',
      policyFingerprint: 'policy', catalogBinding: 'main', modelSettings: {} };
    const specs: WorkerRunSpec[] = [];
    const runtime = new WorkflowRuntime({
      path: ':memory:', resolveRoot: async () => root, wakeMain: async () => {},
      runner: { async start(spec: WorkerRunSpec) {
        specs.push(spec); await spec.validateBeforeRun();
        return { runId: 'run', result: Promise.resolve('completed' as const), stop: async () => {}, waitForExit: async () => true, stopReason: () => undefined,
          async *events() { yield { type: 'final_text' as const, text: 'ok' }; yield { type: 'done' as const, normal: true }; } };
      } },
    });
    await runtime.start(); cleanup.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'plain', plan: 'One worker.', script: 'return await agent("go", {key:"a"});' }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(specs).toHaveLength(1); });
    expect(specs[0]!.env).not.toHaveProperty('TMPDIR');
    expect(specs[0]!.systemPrompt).not.toContain('Scratch directory');
  });
});
