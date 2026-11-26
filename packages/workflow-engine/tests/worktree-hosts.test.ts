import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, stopReasonOf, WorkflowRuntime, type WorkerRunner, type WorkerRunSpec, type WorkflowRoot, type WorkflowStopReason } from '../src';
import { workspaceCommand } from '../src/engine/workspace-process';
import type { WorkspaceBinding } from '../src/engine/workspace-types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, new AbortController().signal);
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

interface FakeHost { agentKind: string; finish(text: string): void; done: Promise<string> }

/** Hosted processes that survive WorkflowRuntime.close, as bin/run-host.mjs does for the bridge. */
function hostedRunner() {
  const hosts = new Map<string, FakeHost>();
  const released: string[] = [];
  const specs: WorkerRunSpec[] = [];
  /** Hosts that are gone for attaching but whose process cannot be confirmed to have ended. */
  const lingering = new Set<string>();
  const runner: WorkerRunner = {
    hosting: {
      newKey: () => randomUUID(),
      attachable: async (key, agentKind) => hosts.get(key)?.agentKind === agentKind,
      release: async key => { released.push(key); hosts.delete(key); return !lingering.has(key); },
    },
    async start(spec) {
      await spec.validateBeforeRun();
      const key = spec.host!.key;
      if (!spec.host!.attach) {
        let finish!: (text: string) => void;
        const done = new Promise<string>(resolve => { finish = resolve; });
        hosts.set(key, { agentKind: spec.execution.agentKind, finish, done });
      }
      // Recorded once its host exists: a test waits on specs to know the key it may finish.
      specs.push(spec);
      const host = hosts.get(key)!;
      let stopped: WorkflowStopReason | undefined;
      let wake!: () => void;
      const interrupted = new Promise<undefined>(resolve => { wake = () => resolve(undefined); });
      const abort = () => { stopped ??= stopReasonOf(spec.signal); wake(); };
      spec.signal.addEventListener('abort', abort, { once: true });
      // The checks before the run end with file system calls, which a stop can fall between.
      if (spec.signal.aborted) abort();
      const outcome = Promise.race([host.done, interrupted]);
      return {
        runId: randomUUID(), hosted: true, result: outcome.then(text => text === undefined ? 'stopped' : 'completed'),
        stop: async reason => { stopped ??= reason; wake(); }, waitForExit: async () => true, stopReason: () => stopped,
        async *events() {
          yield { type: 'session', nativeSessionId: spec.resume?.id ?? `native-${key}` };
          const text = await outcome;
          if (text === undefined) return;
          yield { type: 'final_text', text };
          yield { type: 'done', normal: true };
        },
      };
    },
  };
  return { runner, hosts, released, specs, lingering };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'worktree-hosts-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'README'), 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  let root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: repo,
    policyFingerprint: 'full', catalogBinding: 'main', modelSettings: {} };
  const fake = hostedRunner();
  const path = join(dir, 'workflows.sqlite');
  const create = () => new WorkflowRuntime({ path, resolveRoot: async () => root, wakeMain: async () => {}, authorizeWorkspace: async () => {},
    retryDelaysMs: [20], runner: fake.runner });
  let runtime = create();
  await runtime.start();
  cleanup.push(() => runtime.close());
  const state = () => runtime.kernel.state(root.scopeId)!;
  return {
    ...fake, dir, repo, state,
    until: (check: () => void | Promise<void>, timeout = 10_000) => vi.waitFor(async () => { await runtime.tick(); await check(); }, { timeout, interval: 20 }),
    async run(script: string, args: Record<string, unknown> = {}) {
      const main = runtime.bindMain(root.scopeId, 'start');
      await callWorkflow('run_script', { operationId: randomUUID(), goal: 'hosted worktree', plan: 'One long worker in a worktree.', script, args }, main.env);
      main.release();
    },
    stop: () => runtime.close(),
    resume: async () => { runtime = create(); await runtime.start(); },
    changeRoot: () => { root = { ...root, catalogBinding: 'replacement' }; },
    replay: () => runtime.kernel.call({ kind: 'main', scopeId: root.scopeId }, 'replay_script',
      { operationId: randomUUID(), workflowId: state().workflowId, expectedStateVersion: state().stateVersion }),
    /** The lease on each worktree by its path, as the next controller will find it. */
    leases() {
      const db = new Database(path + '.workspaces.sqlite', { readonly: true });
      try {
        const rows = db.prepare("SELECT data FROM workspace_records WHERE kind='workspace'").all() as Array<{ data: string }>;
        return new Map(rows.map(row => JSON.parse(row.data) as WorkspaceBinding).map(ws => [ws.path, ws.busy]));
      } finally { db.close(); }
    },
    /** The lease on the only worktree. */
    lease() { return [...this.leases().values()][0]; },
    /** Loses what the kernel knows about the processes left running, as a crash between two writes can. */
    forgetHosts() {
      const db = new Database(path);
      try { db.prepare('DELETE FROM workflow_worker_hosts').run(); } finally { db.close(); }
    },
    result: () => JSON.parse(state().artifacts.find(artifact => artifact.ref === state().script!.resultRef)!.text) as unknown,
  };
}

const oneWorker = 'const ws = await createWorkspace({key:"w"}); return await agent("long task", {key:"long", workspace: ws.id});';

describe('hosted workers in managed worktrees', () => {
  it('leaves the worker running across a restart, with the worktree, and continues it in the replayed turn', async () => {
    const h = await harness();
    await h.run(oneWorker);
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!;
    expect(first.host).toMatchObject({ attach: false });
    expect(h.lease()).toMatchObject({ taskId: h.state().tasks[0]!.taskId, hostKey: first.host!.key });

    await h.stop();
    // The process goes on working in the worktree, so nothing else may take it meanwhile.
    expect(h.released).toEqual([]);
    expect(h.lease()).toMatchObject({ hostKey: first.host!.key });
    await h.resume();
    await h.until(() => expect(h.specs).toHaveLength(2));
    expect(h.specs[1]!.host).toEqual({ key: first.host!.key, attach: true });
    expect(h.specs[1]!.workspace).toEqual(first.workspace);
    await h.until(() => expect(h.state().tasks.at(-1)?.status).toBe('running'));
    // The lease now answers for the task that continues the turn.
    expect(h.lease()).toMatchObject({ taskId: h.state().tasks.at(-1)!.taskId, hostKey: first.host!.key });

    h.hosts.get(first.host!.key)!.finish('finished in the worktree');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.result()).toBe('finished in the worktree');
    expect(h.released).toEqual([first.host!.key]);
    expect(h.lease()).toBeUndefined();
  }, 30_000);

  it('lets the continued member land the commits of its worktree and finish its claim with the token it started with', async () => {
    const h = await harness();
    await h.run(`const landing = await configureLanding({key:"landing", checks: args.checks});
      const ws = await createWorkspace({key:"w"});
      await enqueueWork({key:"bug", title:"Bug", input:null});
      await agent("fix", {key:"turn", member:"A", workspace: ws.id});
      return landing.targetRef;`, { checks: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] });
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!, cwd = first.workspace!.path;
    const grant = await callWorkflow('claim_work', { operationId: 'claim-1' }, first.env) as { claimId: string; generation: number };
    await writeFile(join(cwd, 'fix.txt'), 'fixed\n'); await git(cwd, 'add', '.');
    await git(cwd, '-c', 'user.name=Fixer', '-c', 'user.email=fixer@localhost', 'commit', '-m', 'fix');

    await h.stop();
    // A call made while no controller listens waits for the next one instead of failing.
    const status = callWorkflow('read_context', {}, first.env);
    await new Promise(resolve => setTimeout(resolve, 300));
    await h.resume();
    await expect(status).resolves.toBeTruthy();
    await h.until(() => expect(h.specs).toHaveLength(2));
    expect(h.specs[1]!.host).toEqual({ key: first.host!.key, attach: true });

    // The process never learns of the restart: it submits with the claim ID and generation it was given before it.
    const submitted = await callWorkflow('submit_work', { operationId: 'land-1', claimId: grant.claimId, generation: grant.generation, result: { fixed: true } }, first.env);
    expect(submitted).toMatchObject({ status: 'submitted', key: 'bug', commits: 1, worktree: 'reset' });
    await h.until(() => expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed', result: { fixed: true }, generation: 1 }));
    h.hosts.get(first.host!.key)!.finish('landed');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(await git(h.repo, 'show', `${(h.result() as string).replace('refs/heads/', '')}:fix.txt`)).toBe('fixed');
    expect(h.lease()).toBeUndefined();
  }, 30_000);

  it('fails the script that returns when the queue turned commits back and nobody is left to repair them', async () => {
    const h = await harness();
    // Checks that nothing passes: the queue turns back whatever is submitted.
    await h.run(`const landing = await configureLanding({key:"landing", checks: args.checks});
      const ws = await createWorkspace({key:"w"});
      await enqueueWork({key:"bug", title:"Bug", input:null});
      await agent("fix", {key:"turn", member:"A", workspace: ws.id});
      return landing.targetRef;`, { checks: [{ argv: [process.execPath, '-e', 'process.exit(3)'] }] });
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!, cwd = first.workspace!.path;
    const grant = await callWorkflow('claim_work', { operationId: 'claim-1' }, first.env) as { claimId: string; generation: number };
    await writeFile(join(cwd, 'fix.txt'), 'fixed\n'); await git(cwd, 'add', '.');
    await git(cwd, '-c', 'user.name=Fixer', '-c', 'user.email=fixer@localhost', 'commit', '-m', 'fix');
    expect(await callWorkflow('submit_work', { operationId: 'land-1', claimId: grant.claimId, generation: grant.generation }, first.env)).toMatchObject({ status: 'submitted', key: 'bug' });
    // The member goes on and ends its turn; the script returns after it, and its result waits for the queue.
    h.hosts.get(first.host!.key)!.finish('done');
    await h.until(() => expect(h.state().script?.status).toBe('failed'));
    expect(h.state().script!.error).toContain('the landing queue turned back the commits of 1 work item(s) that nobody was left to repair: bug (check_failed, commits ');
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'pending', assignee: 'A', landing: { status: 'check_failed' } });
  }, 30_000);

  it('ends a submission in flight when the controller closes, and the member gets its answer from the next controller', async () => {
    const h = await harness();
    const gate = join(h.dir, 'checks-wait');
    await writeFile(gate, '');
    // The precheck, which the call waits for, hangs for as long as the gate file exists.
    const precheck = [{ argv: [process.execPath, '-e', `const fs=require('fs');const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(gate)}))clearInterval(t)},20)`] }];
    await h.run(`const landing = await configureLanding({key:"landing", checks: args.checks, precheck: args.precheck});
      const ws = await createWorkspace({key:"w"});
      await agent("fix", {key:"turn", member:"A", workspace: ws.id});
      return landing.targetRef;`, { checks: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }], precheck });
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!, cwd = first.workspace!.path;
    await writeFile(join(cwd, 'fix.txt'), 'fixed\n'); await git(cwd, 'add', '.');
    await git(cwd, '-c', 'user.name=Fixer', '-c', 'user.email=fixer@localhost', 'commit', '-m', 'fix');
    let waited = '';
    const landing = callWorkflow('submit_work', { operationId: 'land-1' }, first.env, { onWait: reason => { waited = reason; } });
    // The submission is at a precheck that does not end.
    await new Promise(resolve => setTimeout(resolve, 1500));

    const started = Date.now();
    await h.stop();
    expect(Date.now() - started).toBeLessThan(10_000);
    await rm(gate);
    await h.resume();
    // The call is made again of the next controller, which prechecks the commits the worktree still holds and takes them.
    const submitted = await landing as { status: string; key: string };
    expect(submitted).toMatchObject({ status: 'submitted', commits: 1 });
    expect(waited).toContain('restarting');
    expect(h.specs[1]!.host).toEqual({ key: first.host!.key, attach: true });
    // The turn ends before the queue is done, and the script after it: its result waits for the commits to land.
    h.hosts.get(first.host!.key)!.finish('landed');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.state().workQueue!.items.find(item => item.key === submitted.key)).toMatchObject({ status: 'completed', doneBy: 'A' });
    expect(await git(h.repo, 'show', `${(h.result() as string).replace('refs/heads/', '')}:fix.txt`)).toBe('fixed');
  }, 60_000);

  it('frees the worktree of a worker that ended while no controller was attached, and runs the turn again in it', async () => {
    const h = await harness();
    await h.run(oneWorker);
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!;
    await h.stop();
    h.hosts.delete(first.host!.key);
    await h.resume();
    await h.until(() => expect(h.specs).toHaveLength(2));
    expect(h.released).toEqual([first.host!.key]);
    expect(h.specs[1]!.host).toMatchObject({ attach: false });
    expect(h.specs[1]!.host!.key).not.toBe(first.host!.key);
    expect(h.specs[1]!.workspace).toEqual(first.workspace);
    await h.until(() => expect(h.lease()).toMatchObject({ hostKey: h.specs[1]!.host!.key }));
    h.hosts.get(h.specs[1]!.host!.key)!.finish('second process');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.result()).toBe('second process');
    expect(h.lease()).toBeUndefined();
  }, 30_000);

  it('keeps the worktree blocked while the process left in it cannot be confirmed to have ended, and frees it once it has', async () => {
    const h = await harness();
    await h.run('const ws = await createWorkspace({key:"w"}); return await agent("long task", {key:"long", workspace: ws.id, onError:"throw"});');
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!;
    await h.stop();
    h.hosts.delete(first.host!.key);
    h.lingering.add(first.host!.key);
    await h.resume();
    await h.until(() => expect(h.state().script?.status).toBe('failed'));
    expect(h.state().script!.error).toContain('execution owner');
    // No second process was started beside the one that may still be there.
    expect(h.specs).toHaveLength(1);
    expect(h.lease()).toMatchObject({ hostKey: first.host!.key });

    h.lingering.delete(first.host!.key);
    await h.replay();
    await h.until(() => expect(h.specs).toHaveLength(2));
    expect(h.specs[1]!.host).toMatchObject({ attach: false });
    expect(h.specs[1]!.workspace).toEqual(first.workspace);
    await h.until(() => expect(h.lease()).toMatchObject({ hostKey: h.specs[1]!.host!.key }));
    h.hosts.get(h.specs[1]!.host!.key)!.finish('after all');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.lease()).toBeUndefined();
  }, 30_000);

  it('ends the worker of a workflow that does not resume and frees its worktree, trying again while it would not end', async () => {
    const h = await harness();
    await h.run(oneWorker);
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const key = h.specs[0]!.host!.key;
    await h.stop();
    h.changeRoot();
    h.lingering.add(key);
    await h.resume();
    expect(h.state()).toMatchObject({ status: 'interrupted', restart: { resume: false } });
    expect(h.released).toEqual([key]);
    expect(h.lease()).toMatchObject({ hostKey: key });
    h.lingering.delete(key);
    await h.until(() => expect(h.lease()).toBeUndefined());
    expect(h.released.length).toBeGreaterThan(1);
    expect(h.specs).toHaveLength(1);
  }, 30_000);

  it('gives the worktree to the turn the script runs when no turn continues the process left in it', async () => {
    const h = await harness();
    await h.run(oneWorker);
    await h.until(() => expect(h.state().tasks[0]?.status).toBe('running'));
    const first = h.specs[0]!;
    await h.stop();
    h.forgetHosts();
    await h.resume();
    await h.until(() => expect(h.specs).toHaveLength(2));
    // The process was ended before another was started in its worktree.
    expect(h.released).toEqual([first.host!.key]);
    expect(h.hosts.has(first.host!.key)).toBe(false);
    expect(h.specs[1]!.host).toMatchObject({ attach: false });
    expect(h.specs[1]!.workspace).toEqual(first.workspace);
    await h.until(() => expect(h.lease()).toMatchObject({ hostKey: h.specs[1]!.host!.key }));
    h.hosts.get(h.specs[1]!.host!.key)!.finish('second process');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.lease()).toBeUndefined();
  }, 30_000);

  it('keeps every swarm member in its own worktree and on its own work item across a restart', async () => {
    const h = await harness();
    await h.run(`const spaces = [await createWorkspace({key:"w0"}), await createWorkspace({key:"w1"})];
      for (const n of [0, 1]) await enqueueWork({key:"item-" + n, title:"Item " + n, input:n});
      return await swarm("Claim and finish the queued work", {key:"crew", maxTurns:4,
        members: spaces.map((space, n) => ({name:"w" + n, queue:"default", workspace: space.id}))});`);
    await h.until(() => expect(h.specs).toHaveLength(2));
    const before = h.specs.slice(0, 2);
    const grants = await Promise.all(before.map(spec => callWorkflow('claim_work', { operationId: 'claim-1' }, spec.env) as Promise<{ claimId: string; generation: number; item: { key: string } }>));
    expect(new Set(before.map(spec => spec.workspace!.path)).size).toBe(2);
    // Both processes are up; one that had not started yet would be ended with the controller instead.
    await h.until(() => { for (const spec of before) expect(h.leases().get(spec.workspace!.path)).toMatchObject({ hostKey: spec.host!.key }); });

    await h.stop();
    expect(h.released).toEqual([]);
    for (const spec of before) expect(h.leases().get(spec.workspace!.path)).toMatchObject({ hostKey: spec.host!.key });
    await h.resume();
    await h.until(() => expect(h.specs).toHaveLength(4));
    // Each member's process is continued where it runs, whichever order the replay reaches the members in.
    for (const spec of before) {
      const again = h.specs.slice(2).find(item => item.host!.key === spec.host!.key)!;
      expect(again.host).toEqual({ key: spec.host!.key, attach: true });
      expect(again.workspace).toEqual(spec.workspace);
    }
    expect(h.released).toEqual([]);
    expect(h.state().workQueue!.claims.map(claim => claim.status)).toEqual(['active', 'active']);
    for (const [index, grant] of grants.entries()) {
      await callWorkflow('complete_work', { operationId: 'done-1', claimId: grant.claimId, generation: grant.generation, result: grant.item.key }, before[index]!.env);
    }
    expect(h.state().workQueue!.items.map(item => item.status)).toEqual(['completed', 'completed']);
  }, 30_000);

  it('continues a reviewer in its frozen snapshot, which is verified when the review ends rather than while it runs', async () => {
    const h = await harness();
    await h.run(`const ws = await createWorkspace({key:"w"});
      await agent("write", {key:"write", workspace: ws.id});
      const change = await freezeWorkspace({key:"freeze", workspace: ws.id});
      const snapshot = await createWorkspace({key:"snapshot", change: change.id});
      return await agent("review", {key:"review", workspace: snapshot.id, onError:"throw"});`);
    await h.until(() => expect(h.specs).toHaveLength(1));
    const writer = h.specs[0]!;
    await writeFile(join(writer.workspace!.path, 'work.txt'), 'work\n'); await git(writer.workspace!.path, 'add', '.');
    await git(writer.workspace!.path, '-c', 'user.name=Writer', '-c', 'user.email=writer@localhost', 'commit', '-m', 'work');
    h.hosts.get(writer.host!.key)!.finish('written');
    await h.until(() => expect(h.specs).toHaveLength(2));
    const reviewer = h.specs[1]!, notes = join(reviewer.workspace!.path, 'notes.tmp');
    await h.until(() => expect(h.leases().get(reviewer.workspace!.path)).toMatchObject({ hostKey: reviewer.host!.key }));

    await h.stop();
    // What the reviewer has lying about mid-turn does not keep it from being continued.
    await writeFile(notes, 'scratch');
    await h.resume();
    await h.until(() => expect(h.specs).toHaveLength(3));
    expect(h.specs[2]!.host).toEqual({ key: reviewer.host!.key, attach: true });
    await rm(notes);
    h.hosts.get(reviewer.host!.key)!.finish('looks right');
    await h.until(() => expect(h.state().script?.status).toBe('result_ready'));
    expect(h.result()).toBe('looks right');
  }, 30_000);
});
