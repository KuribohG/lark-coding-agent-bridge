import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, stopReasonOf, WorkflowRuntime, type WorkerRunner, type WorkerRunSpec, type WorkflowRoot, type WorkflowStopReason } from '../src';
import { workspaceCommand } from '../src/engine/workspace-process';
import type { WorkspaceBinding } from '../src/engine/workspace-types';
import { gate, writes } from './helpers/held-git';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 30_000);
const exists = (path: string) => access(path).then(() => true, () => false);
async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, new AbortController().signal);
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

/** Turns that run until the workflow stops them: a member that has started is one whose spec is here. */
function standingRunner() {
  const specs: WorkerRunSpec[] = [];
  const runner: WorkerRunner = {
    async start(spec) {
      await spec.validateBeforeRun();
      specs.push(spec);
      let stopped: WorkflowStopReason | undefined;
      let end!: () => void;
      const ended = new Promise<void>(resolve => { end = resolve; });
      const abort = () => { stopped ??= stopReasonOf(spec.signal); end(); };
      spec.signal.addEventListener('abort', abort, { once: true });
      if (spec.signal.aborted) abort();
      return { runId: randomUUID(), result: ended.then(() => 'stopped' as const), stop: async reason => { stopped ??= reason; end(); },
        waitForExit: async () => true, stopReason: () => stopped,
        async *events() { yield { type: 'session' as const, nativeSessionId: spec.resume?.id ?? 'native-' + randomUUID() }; await ended; } };
    },
  };
  return { runner, specs };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-worktrees-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'README'), 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: repo,
    policyFingerprint: 'full', catalogBinding: 'main', modelSettings: {} };
  const fake = standingRunner(), held = gate(dir);
  const path = join(dir, 'workflows.sqlite');
  const create = () => new WorkflowRuntime({ path, resolveRoot: async () => root, wakeMain: async () => {}, authorizeWorkspace: async () => {},
    retryDelaysMs: [20], runner: fake.runner, processes: held.processes });
  let runtime = create();
  await runtime.start();
  cleanup.push(() => runtime.close());
  const state = () => runtime.kernel.state(root.scopeId)!;
  const main = <T = unknown>(method: string, args: Record<string, unknown> = {}) => {
    const bound = runtime.bindMain(root.scopeId, runtime.kernel.state(root.scopeId) ? 'continue' : 'start');
    return (callWorkflow(method, { operationId: randomUUID(), ...args }, bound.env) as Promise<T>).finally(() => bound.release());
  };
  return {
    ...fake, held, dir, repo, state, main,
    until: (check: () => void | Promise<void>, timeout = 10_000) => vi.waitFor(async () => { await runtime.tick(); await check(); }, { timeout, interval: 20 }),
    /** Lets the scheduler pass a few times, for what must not happen. */
    async settle() { for (let pass = 0; pass < 5; pass++) { await runtime.tick(); await new Promise(done => setTimeout(done, 30)); } },
    run: (script: string) => main('run_script', { goal: 'start before every worktree is written', plan: 'A swarm whose members have worktrees.', script }),
    member: (name: string) => state().swarms![0]!.members.find(member => member.name === name)!,
    started: (name: string) => fake.specs.filter(spec => spec.memberKey === name),
    worktrees() {
      const db = new Database(path + '.workspaces.sqlite', { readonly: true });
      try { return (db.prepare("SELECT data FROM workspace_records WHERE kind='workspace'").all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as WorkspaceBinding); } finally { db.close(); }
    },
    stop: () => runtime.close(),
    resume: async () => { runtime = create(); await runtime.start(); },
  };
}

/** A swarm of one member with a worktree and three items to claim. */
const oneMember = `const ws = await createWorkspace({key:"w0"});
  for (const n of [0, 1, 2]) await enqueueWork({key:"item-" + n, title:"Item " + n, input:n});
  return await swarm("Claim and finish the queued work", {key:"crew", maxTurns:4, members:[{name:"w0", queue:"default", workspace: ws.id}]});`;

describe('a swarm whose worktrees are still being written', () => {
  it('starts with the members whose worktrees are ready and wakes each other member when its own is', async () => {
    const h = await harness();
    // The files of every worktree but the first to be written are held back.
    let first: string | undefined;
    h.held.hold((args, cwd) => writes(args, cwd) && cwd !== (first ??= cwd));
    await h.run(`const spaces = [];
      for (const n of [0, 1, 2]) spaces.push(await createWorkspace({key:"w" + n}));
      for (const n of [0, 1, 2]) await enqueueWork({key:"item-" + n, title:"Item " + n, input:n});
      return await swarm("Claim and finish the queued work", {key:"crew", maxTurns:4,
        members: spaces.map((space, n) => ({name:"w" + n, queue:"default", workspace: space.id}))});`);
    await h.until(() => expect(h.specs).toHaveLength(1));
    await h.settle();
    expect(h.specs.map(spec => spec.memberKey)).toEqual(['w0']);
    expect(h.state().swarms![0]).toMatchObject({ status: 'running' });
    expect(h.state().swarms![0]!.members.map(member => member.stopped)).toEqual([undefined, undefined, undefined]);
    // The work goes to who can do it: a member that has not been woken has claimed nothing.
    const grant = await callWorkflow('claim_work', { operationId: 'claim-1' }, h.specs[0]!.env) as { item: { key: string } };
    expect(grant.item.key).toMatch(/^item-/);
    expect(h.worktrees().map(ws => ws.status).sort()).toEqual(['preparing', 'preparing', 'ready']);

    await h.held.release();
    await h.until(() => expect(h.specs.map(spec => spec.memberKey).sort()).toEqual(['w0', 'w1', 'w2']));
    for (const spec of h.specs) expect(await exists(join(spec.workspace!.path, 'README'))).toBe(true);
    expect(new Set(h.specs.map(spec => spec.workspace!.path)).size).toBe(3);
    expect(h.worktrees().map(ws => ws.status)).toEqual(['ready', 'ready', 'ready']);
  }, 30_000);

  it('adds members at once and wakes each when its worktree is ready', async () => {
    const h = await harness();
    await h.run(oneMember);
    await h.until(() => expect(h.started('w0')).toHaveLength(1));
    h.held.hold(writes);
    const added = await h.main<{ added: string[]; workspaces: Array<{ name: string; workspace: string }> }>('staff_swarm', { add: ['w1', 'w2'], like: 'w0', workspace: true });
    expect(added).toMatchObject({ added: ['w1', 'w2'], workspaces: [{ name: 'w1' }, { name: 'w2' }] });
    expect(h.member('w1')).toMatchObject({ workspace: added.workspaces[0]!.workspace, queue: 'default' });
    await h.settle();
    expect(h.specs.map(spec => spec.memberKey)).toEqual(['w0']);
    expect(h.member('w1').stopped).toBeUndefined();
    await h.held.release();
    await h.until(() => expect(h.specs.map(spec => spec.memberKey).sort()).toEqual(['w0', 'w1', 'w2']));
    expect(h.started('w1')[0]!.workspace).toMatchObject({ id: added.workspaces[0]!.workspace });
  }, 30_000);

  it('stops a member whose worktree could not be written, and writes it again when the member is revived', async () => {
    const h = await harness();
    await h.run(oneMember);
    await h.until(() => expect(h.started('w0')).toHaveLength(1));
    let full = true;
    h.held.fail(args => full && args.includes('read-tree'));
    await h.main('staff_swarm', { add: ['w1'], like: 'w0', workspace: true });
    await h.until(() => expect(h.member('w1')).toMatchObject({ stopped: 'failed', detail: expect.stringMatching(/^its worktree could not be prepared: Git read-tree failed: no space left on device/) }));
    await h.settle();
    expect(h.started('w1')).toHaveLength(0);
    // The swarm goes on with the member it has.
    expect(h.state().swarms![0]).toMatchObject({ status: 'running' });
    full = false;
    await h.main('staff_swarm', { revive: ['w1'] });
    await h.until(() => expect(h.started('w1')).toHaveLength(1));
    expect(await exists(join(h.started('w1')[0]!.workspace!.path, 'README'))).toBe(true);
  }, 30_000);

  it('removes what was made of a worktree when its member is given up before it is ready', async () => {
    const h = await harness();
    await h.run(oneMember);
    await h.until(() => expect(h.started('w0')).toHaveLength(1));
    h.held.hold(writes);
    const added = await h.main<{ workspaces: Array<{ workspace: string }> }>('staff_swarm', { add: ['w1'], like: 'w0', workspace: true });
    const made = () => h.worktrees().find(ws => ws.id === added.workspaces[0]!.workspace)!;
    await h.until(async () => expect(await exists(join(made().path, '.git'))).toBe(true));
    await h.main('staff_swarm', { retire: ['w1'] });
    expect(await h.main('staff_swarm', { cleanup: ['w1'] })).toMatchObject({ cleaned: ['w1'] });
    expect(made().status).toBe('removed');
    expect(await exists(made().path)).toBe(false);
    await h.held.release();
    await h.settle();
    expect(h.started('w1')).toHaveLength(0);
  }, 30_000);

  it('writes the worktree of a waiting member after a restart, and stops writing it when the workflow is cancelled', async () => {
    const h = await harness();
    await h.run(oneMember);
    await h.until(() => expect(h.started('w0')).toHaveLength(1));
    h.held.hold(writes);
    const added = await h.main<{ workspaces: Array<{ workspace: string }> }>('staff_swarm', { add: ['w1', 'w2'], like: 'w0', workspace: true });
    const made = (index: number) => h.worktrees().find(ws => ws.id === added.workspaces[index]!.workspace)!;
    await h.until(async () => expect(await exists(join(made(0).path, '.git'))).toBe(true));
    await h.stop();
    expect(made(0).status).toBe('preparing');
    // Held again after the restart: only the first of the two is let through.
    h.held.hold((args, cwd) => writes(args, cwd) && cwd !== made(0).path);
    await h.resume();
    await h.until(() => expect(h.started('w1')).toHaveLength(1));
    expect(made(0).status).toBe('ready');
    expect(made(1).status).toBe('preparing');
    expect(h.started('w2')).toHaveLength(0);

    await h.main('cancel_workflow', { workflowId: h.state().workflowId, expectedStateVersion: h.state().stateVersion });
    await h.settle();
    await h.held.release();
    await new Promise(done => setTimeout(done, 300));
    expect(made(1).status).toBe('preparing');
    expect(await exists(join(made(1).path, 'README'))).toBe(false);
  }, 30_000);

  it('makes a script turn in a worktree that is still being prepared wait for it', async () => {
    const h = await harness(); h.held.hold(writes);
    await h.run('const ws = await createWorkspace({key:"w"}); return await agent("work", {key:"turn", workspace: ws.id});');
    await h.until(() => expect(h.worktrees()).toHaveLength(1));
    await h.settle();
    expect(h.specs).toHaveLength(0);
    expect(h.state().tasks).toHaveLength(0);
    await h.held.release();
    await h.until(() => expect(h.specs).toHaveLength(1));
    expect(await exists(join(h.specs[0]!.workspace!.path, 'README'))).toBe(true);
  }, 30_000);

  it.each([
    ['the member that has work', 'w3', `await enqueueWork({key:"item", title:"Item", input:1, assignee:"w3"});
      return await swarm("Claim and finish the queued work", {key:"crew", maxTurns:4, members: spaces.map((space, n) => ({name:"w" + n, queue:"default", workspace: space.id}))});`],
    ['the lead, who plans before anyone has work', 'w3', `return await swarm("Plan the work and hand it out", {key:"crew", maxTurns:4, lead:{name:"w3", workspace: spaces[3].id},
        members: spaces.slice(0, 3).map((space, n) => ({name:"w" + n, workspace: space.id}))});`],
  ])('gives the next worktree to %s, ahead of the members with nothing to do yet', async (_who, wanted, rest) => {
    const h = await harness();
    // A repository's worktrees are registered one at a time: while the first registration is held, the others wait their turn.
    const adds = () => h.held.ran.filter(args => args.includes('worktree') && args.includes('add'));
    let held: readonly string[] | undefined;
    h.held.hold(args => args.includes('worktree') && args.includes('add') && (held ??= args) === args);
    await h.run(`const spaces = [];
      for (const n of [0, 1, 2, 3]) spaces.push(await createWorkspace({key:"w" + n}));
      ${rest}`);
    await h.until(() => expect(h.state().swarms?.[0]?.members).toHaveLength(4));
    await h.settle();
    expect(adds()).toHaveLength(1);
    await h.held.release();
    await h.until(() => expect(h.started(wanted)).toHaveLength(1));
    await h.until(() => expect(adds()).toHaveLength(4));
    const made = h.worktrees();
    // The second to be registered is the last that was asked for: the one with something to do.
    expect(made.find(ws => adds()[1]!.includes(ws.path))!.id).toBe(h.member(wanted).workspace);
  }, 30_000);

  it('answers a script before the files are written, unless the script asks to wait for them', async () => {
    const h = await harness(); h.held.hold(writes);
    // What each creation answered is in the key of the item the script enqueues after it; the turn keeps the script running.
    await h.run(`const quick = await createWorkspace({key:"quick"});
      await enqueueWork({key:"quick-" + quick.status, title:"Quick", input:1});
      const waited = await createWorkspace({key:"waited", wait:true});
      await enqueueWork({key:"waited-" + waited.status, title:"Waited", input:2});
      return await agent("hold", {key:"hold"});`);
    const items = () => (h.state().workQueue?.items ?? []).map(item => item.key);
    await h.until(() => expect(items()).toEqual(['quick-preparing']));
    await h.settle();
    expect(items()).toEqual(['quick-preparing']);
    await h.held.release();
    await h.until(() => expect(items()).toEqual(['quick-preparing', 'waited-ready']));
  }, 30_000);
});
