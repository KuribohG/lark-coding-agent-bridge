import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow } from '@kuribohg/agent-workflows';
import { createBridgeWorkflowRuntime } from '../../../src/workflows/bridge/runtime';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import type { AgentEvent, AgentRunOptions } from '../../../src/agent/types';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function git(cwd: string, ...argv: string[]) {
  return (await promisify(execFile)('git', argv, { cwd })).stdout.trim();
}
/** What a file of a worktree holds, once the worktree has been written: a member is added before its worktree is. */
const written = (path: string) => vi.waitFor(() => readFile(path, 'utf8'), { timeout: 20_000, interval: 30 });
/** `chat` runs the workflow in a directory that is no checkout, as a bridge does from a chat workspace; the repository is then named to the script. */
async function harness(perform?: (opts: AgentRunOptions, index: number) => Promise<string>, where: 'repo' | 'chat' = 'repo',
  host: Partial<Parameters<typeof createBridgeWorkflowRuntime>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-runtime-'));
  closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = join(dir, 'repo'); await mkdir(repo); await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'value.txt'), 'original\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const cwd = where === 'repo' ? repo : join(dir, 'chat'); await mkdir(cwd, { recursive: true });
  const root = { scopeId: 'test', profile: 'test', agentKind: 'codex' as const, cwdRealpath: cwd, policyFingerprint: 'full', catalogBinding: 'root', modelSettings: {} };
  const policy: RunPolicyAllow = { ok: true, prompt: '', requestedCwd: cwd, cwdRealpath: cwd, accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions', access: { ok: true, reason: 'allowed-user' }, attachments: [], policyFingerprint: 'full', expiresAt: Date.now() + 60_000 };
  const adapter = new FakeAgentAdapter({ id: 'codex', capabilities: { finalAnswer: 'separate-event', input: 'unsupported' } });
  let index = 0;
  const run = adapter.run.bind(adapter);
  adapter.run = opts => {
    const native = run(opts);
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'system', threadId: opts.threadId ?? randomUUID() };
      const text = await perform?.(opts, ++index) ?? 'done';
      yield { type: 'final_text', content: text }; yield { type: 'done', terminationReason: 'normal' };
    })();
    return { runId: native.runId, capabilities: native.capabilities, events, stop: () => native.stop(), waitForExit: ms => native.waitForExit(ms) };
  };
  const runtime = createBridgeWorkflowRuntime({ path: join(dir, 'workflow.sqlite'), workspaceRoot: join(dir, 'worktrees'),
    executor: new RunExecutor({ resolveAgent: () => adapter, pool: new ProcessPool(() => 4), activeRuns: new ActiveRuns() }),
    resolve: async () => ({ root, policy }), wakeMain: async () => {}, ...host });
  await runtime.start();
  closes.push(() => runtime.close());
  const state = () => runtime.kernel.state('test')!;
  const call = (method: string, args: object = {}) => runtime.kernel.call({ kind: 'main', scopeId: 'test', allowStart: true }, method,
    { operationId: randomUUID(), workflowId: state()?.workflowId, expectedStateVersion: state()?.stateVersion, ...(method === 'run_script' ? { goal: 'test workspace', plan: 'isolate and review work' } : {}), ...args });
  const until = async (status: string, timeout = 20_000) => vi.waitFor(async () => { await runtime.tick(); expect(state().script?.status, state().script?.error).toBe(status); }, { timeout, interval: 30 });
  return { dir, repo, root, policy, adapter, runtime, call, state, until };
}

const reviewScript = `
  const ws=await createWorkspace({key:'writer'});
  const result=await reviewedAgent('Implement value.txt',{key:'task',criteria:'File must contain correct',maxRounds:2,onError:'throw',
    worker:{harness:'codex',model:'writer',workspace:ws.id},reviewer:{harness:'codex',model:'reviewer'}});
  const merged=await integrateChanges({key:'merge',approvals:[result.approval.id]});
  const checks=await checkWorkspace({key:'checks',workspace:merged.workspace.id,commands:[{argv:[args.node,'-e',"if(require('fs').readFileSync('value.txt','utf8').trim()!=='correct')process.exit(1)"]}]});
  const accepted=await acceptIntegration({key:'accept',workspace:merged.workspace.id,checks:checks.id});
  return {result,accepted};`;

describe('workspace script runtime', () => {
  it('runs rework in one member, reviews fixed snapshots independently, integrates and replays', async () => {
    let workers = 0, reviews = 0;
    const h = await harness(async opts => {
      if (opts.model === 'writer') {
        await writeFile(join(opts.cwd!, 'value.txt'), ++workers === 1 ? 'wrong\n' : 'correct\n');
        await git(opts.cwd!, 'add', '.'); await git(opts.cwd!, 'commit', '-m', 'implementation'); return 'Inspect value.txt';
      }
      const value = await readFile(join(opts.cwd!, 'value.txt'), 'utf8'); reviews++;
      return JSON.stringify({ ok: value === 'correct\n', reason: value === 'correct\n' ? 'correct' : 'fix value', evidence: [`Read value.txt: ${value}`] });
    });
    await h.call('run_script', { script: reviewScript, args: { node: process.execPath } }); await h.until('result_ready', 75_000);
    expect([workers, reviews]).toEqual([2, 2]);
    const result = JSON.parse(h.state().artifacts.at(-1)!.text);
    expect(result.result.rounds).toBe(2); expect(result.accepted.completed).toBe(true);
    expect(await readFile(join(h.repo, 'value.txt'), 'utf8')).toBe('original\n');
    const runs = h.adapter.runOptions;
    expect(runs.every(opts => opts.cwd !== h.repo)).toBe(true);
    expect(runs[0]!.cwd).toBe(runs[2]!.cwd); expect(runs[1]!.cwd).not.toBe(runs[3]!.cwd);
    expect(runs[2]!.threadId).toBeDefined(); expect(runs[1]!.threadId).toBeUndefined();
    await h.call('replay_script'); await h.until('result_ready', 75_000); expect(h.adapter.runs).toHaveLength(4);
    expect(JSON.parse(h.state().artifacts.at(-1)!.text)).toEqual(result);
  }, 90_000);

  it('rejects dirty reviewers before recording successful task results', async () => {
    const h = await harness(async opts => {
      if (opts.model === 'writer') { await writeFile(join(opts.cwd!, 'value.txt'), 'correct\n'); await git(opts.cwd!, 'add', '.'); await git(opts.cwd!, 'commit', '-m', 'work'); return 'candidate'; }
      await writeFile(join(opts.cwd!, 'untracked'), 'review contamination');
      return JSON.stringify({ ok: true, reason: 'approved', evidence: ['claimed check'] });
    });
    await h.call('run_script', { script: reviewScript, args: { node: process.execPath } }); await h.until('failed');
    expect(h.state().script!.error).toContain('untracked');
    expect(h.state().tasks.at(-1)!.status).toBe('failed');
  }, 30_000);

  it('requires full authorization and does not change persistent member workspace bindings', async () => {
    const h = await harness(); h.policy.accessMode = 'read-only';
    await h.call('run_script', { script: "return await createWorkspace({key:'a'});" }); await h.until('failed');
    expect(h.state().script!.error).toContain('full-access'); expect(h.adapter.runs).toHaveLength(0);
    h.policy.accessMode = 'full';
    await h.call('replay_script', { plan: 'check workspace member binding', script: `
      const a=await createWorkspace({key:'a'}),b=await createWorkspace({key:'b'});
      await agent('first',{key:'first',member:'writer',workspace:a.id});
      return await agent('second',{key:'second',member:'writer',workspace:b.id});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('workspace'); expect(h.adapter.runs).toHaveLength(1);
  }, 30_000);

  it('reserves workspace keys across all script APIs and rejects simultaneous tasks in one workspace', async () => {
    const h = await harness();
    await h.call('run_script', { script: `const ws=await createWorkspace({key:'a'}); return await agent('task',{key:'a',workspace:ws.id});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('workspace operation');
    await h.call('replay_script', { plan: 'check concurrent ownership', script: `const ws=await createWorkspace({key:'a'});
      await startAgent('first',{key:'first',workspace:ws.id}); return await startAgent('second',{key:'second',workspace:ws.id});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('unfinished task');
  }, 30_000);

  it('retains ownership if the native adapter cannot confirm termination', async () => {
    const h = await harness(); h.adapter.setWaitForExit(false);
    await h.call('run_script', { script: `const ws=await createWorkspace({key:'a'}); return await agent('task',{key:'first',workspace:ws.id,onError:'throw'});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('termination is uncertain');
    await h.call('replay_script', { plan: 'verify owner retention', script: `const ws=await createWorkspace({key:'a'}); return await freezeWorkspace({key:'freeze',workspace:ws.id});` });
    await h.until('failed'); expect(h.state().script!.error).toContain('Wait for every workspace task');
  }, 30_000);

  it('makes a worktree for each member a running swarm adds, from the main agent or its lead', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: Array<{ model?: string; cwd?: string }> = [];
    let staffed: { workspaces?: Array<{ name: string; workspace: string }> } | undefined;
    const h = await harness(async opts => {
      seen.push({ model: opts.model, cwd: opts.cwd });
      if (opts.model === 'lead') {
        staffed = await callWorkflow('staff_swarm', { operationId: randomUUID(), add: ['w1'], workspace: true }, { ...opts.env }) as typeof staffed;
        return 'staffed the swarm';
      }
      await gate; return 'done';
    });
    try {
      // A member that does the work starts with its first item, so each of the two has one that is kept for it.
      await h.call('run_script', { script: `await enqueueWork({key:'a',title:'A',input:1,assignee:'w0'}); await enqueueWork({key:'b',title:'B',input:2,assignee:'w1'});
        return await swarm('Write in parallel',{key:'crew',
        lead:{name:'boss',harness:'codex',model:'lead'},members:[{name:'w0',harness:'codex',model:'worker'}]});` });
      await vi.waitFor(async () => { await h.runtime.tick(); expect(staffed?.workspaces).toHaveLength(1); }, { timeout: 20_000, interval: 30 });
      const id = staffed!.workspaces![0]!.workspace;
      expect(staffed!.workspaces![0]!.name).toBe('w1');
      expect(h.state().swarms![0]!.members.find(member => member.name === 'w1')!.workspace).toBe(id);
      // The worktree is a checkout of the workflow's repository at its committed baseline, not the root itself. Its
      // files are written after the call has answered.
      expect(await written(join(h.dir, 'worktrees', h.state().workflowId, id, 'value.txt'))).toBe('original\n');
      await vi.waitFor(async () => { await h.runtime.tick(); expect(seen.filter(run => run.model === 'worker').length).toBe(2); }, { timeout: 20_000, interval: 30 });
      // w0 keeps the root checkout; w1 runs inside the worktree made for it.
      expect(seen.filter(run => run.model === 'worker' && run.cwd === h.repo)).toHaveLength(1);
      expect(seen.filter(run => run.model === 'worker' && run.cwd?.includes(id))).toHaveLength(1);
    } finally { release(); }
  }, 60_000);

  it('runs the leads as the main agent is run, and confines the other members to what they are to write', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: AgentRunOptions[] = [];
    const h = await harness(async opts => { seen.push(opts); await gate; return 'done'; }, 'repo', {
      signalCell: sessionKey => ({ id: sessionKey }),
      workerSandbox: () => ({ enabled: true, requireLandlock: true, allowTcp: true, readWrite: ['/shared/pool'], readOnly: [] }) });
    try {
      await h.call('run_script', { script: `const a=await createWorkspace({key:'a'}), q=await createWorkspace({key:'q'});
        await enqueueWork({key:'i',title:'I',input:1,queue:'core'});
        return await swarm('Write in parallel',{key:'crew',lead:{name:'boss',harness:'codex',model:'lead'},members:[
          {name:'planner',harness:'codex',model:'planner',leads:['core'],workspace:q.id},
          {name:'w0',harness:'codex',model:'worker',queue:'core',workspace:a.id}]});` });
      await vi.waitFor(async () => { await h.runtime.tick(); expect([...new Set(seen.map(run => run.model))].sort()).toEqual(['lead', 'planner', 'worker']); }, { timeout: 20_000, interval: 30 });
      const of = (model: string) => seen.find(run => run.model === model)!;
      // The lead of the swarm and the lead of a queue: no cell, the sandbox of their profile (none here), and no word of either.
      for (const lead of [of('lead'), of('planner')]) {
        expect(lead.signalCell).toBeUndefined();
        expect(lead.execSandbox).toBeUndefined();
        expect(lead.systemPrompt).not.toMatch(/Signals:|Writes:/);
      }
      // A member that does the work: a cell of its own, and a sandbox that is opened for what a commit in its worktree
      // writes outside it, which is its own Git directory and the objects of the repository.
      const worker = of('worker');
      expect(worker.signalCell?.id).toBe(`workflow:${h.state().workflowId}:${h.state().sessions.find(session => session.workspaceId && worker.cwd!.includes(session.workspaceId))!.sessionRef}`);
      expect(worker.execSandbox).toMatchObject({ enabled: true, requireLandlock: true, allowTcp: true, readOnly: [] });
      expect(worker.execSandbox!.readWrite).toEqual(['/shared/pool', await git(worker.cwd!, 'rev-parse', '--absolute-git-dir'),
        join(await git(h.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'objects')]);
      expect(worker.systemPrompt).toContain('`Permission denied` anywhere else is the sandbox you run in');
      expect(worker.systemPrompt).toContain('`Operation not permitted` from kill or pkill means');
    } finally { release(); }
  }, 60_000);

  it('adds members with worktrees from the main agent too, and reuses them when the call is retried', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await harness(async () => { await gate; return 'done'; });
    try {
      await h.call('run_script', { script: `return await swarm('Write in parallel',{key:'crew',members:[{name:'w0',harness:'codex',model:'worker'}]});` });
      await vi.waitFor(async () => { await h.runtime.tick(); expect(h.adapter.runs).toHaveLength(1); }, { timeout: 20_000, interval: 30 });
      const operationId = randomUUID();
      const staff = (id: string) => h.runtime.kernel.call({ kind: 'main', scopeId: 'test', workflowId: h.state().workflowId }, 'staff_swarm',
        { operationId: id, add: ['w1', 'w2'], workspace: true }) as Promise<{ workspaces: Array<{ name: string; workspace: string }> }>;
      const added = await staff(operationId);
      expect(added.workspaces).toHaveLength(2);
      const ids = added.workspaces.map(entry => entry.workspace);
      expect(new Set(ids).size).toBe(2);
      for (const [index, id] of ids.entries()) {
        expect(h.state().swarms![0]!.members.find(member => member.name === `w${index + 1}`)!.workspace).toBe(id);
        expect(await written(join(h.dir, 'worktrees', h.state().workflowId, id, 'value.txt'))).toBe('original\n');
      }
      // The operation is idempotent: the same ID returns the recorded result without making more worktrees.
      const again = await staff(operationId);
      expect(again.workspaces).toEqual(added.workspaces);
    } finally { release(); }
  }, 60_000);

  it('makes an added member a worktree like the one of the member it is added like, when the workflow itself runs outside a checkout', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await harness(async () => { await gate; return 'done'; }, 'chat');
    try {
      // One member works in the workflow's directory, one in a worktree of the repository and one in a clone of it.
      await h.call('run_script', { args: { repo: h.repo }, script: `
        const tree = await createWorkspace({key:'tree', repo: args.repo}), clone = await createWorkspace({key:'clone', repo: args.repo, isolation: 'clone'});
        return await swarm('Write in parallel',{key:'crew',members:[{name:'p0',harness:'codex',model:'worker'},
          {name:'t0',harness:'codex',model:'worker',workspace:tree.id},{name:'c0',harness:'codex',model:'worker',workspace:clone.id}]});` });
      await vi.waitFor(async () => { await h.runtime.tick(); expect(h.adapter.runs).toHaveLength(3); }, { timeout: 30_000, interval: 30 });
      const main = { kind: 'main' as const, scopeId: 'test', workflowId: h.state().workflowId };
      const staff = (args: object) => h.runtime.kernel.call(main, 'staff_swarm', { operationId: randomUUID(), ...args }) as Promise<{ workspaces: Array<{ name: string; workspace: string }> }>;
      const path = (id: string) => join(h.dir, 'worktrees', h.state().workflowId, id);
      // Like a member without a worktree, the repository would be the workflow's directory, which is none: the refusal says so.
      await expect(staff({ add: ['t1'], workspace: true })).rejects.toThrow(/not a Git checkout .*repo option/);
      expect(h.state().swarms![0]!.members.some(member => member.name === 't1')).toBe(false);
      // The name that call could not add is not lost: like a member with a worktree, it gets one from the same repository.
      const tree = (await staff({ add: ['t1'], like: 't0', workspace: true })).workspaces[0]!;
      expect(tree.name).toBe('t1');
      expect(h.state().swarms![0]!.members.find(member => member.name === 't1')!.workspace).toBe(tree.workspace);
      expect(await written(join(path(tree.workspace), 'value.txt'))).toBe('original\n');
      expect((await stat(join(path(tree.workspace), '.git'))).isFile()).toBe(true);
      // Like the member in a clone, it gets a clone; a worktree of the repository is still there for the asking.
      const clone = (await staff({ add: ['c1'], like: 'c0', workspace: true })).workspaces[0]!;
      // The clone does not take the source's core.autocrlf, so Git for Windows writes its files with CRLF.
      expect((await written(join(path(clone.workspace), 'value.txt'))).replace(/\r\n/g, '\n')).toBe('original\n');
      expect((await stat(join(path(clone.workspace), '.git'))).isDirectory()).toBe(true);
      const shared = (await staff({ add: ['c2'], like: 'c0', workspace: { isolation: 'worktree' } })).workspaces[0]!;
      await written(join(path(shared.workspace), 'value.txt'));
      expect((await stat(join(path(shared.workspace), '.git'))).isFile()).toBe(true);
    } finally { release(); }
  }, 90_000);

  it('releases a retired member worktree and leaves running or failed ones alone', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let runs = 0;
    // w0 holds the swarm open; the member added later finishes its opening turn so it can be retired.
    const h = await harness(async () => { if (++runs === 1) await gate; return 'done'; });
    try {
      await h.call('run_script', { script: `return await swarm('Write in parallel',{key:'crew',members:[{name:'w0',harness:'codex',model:'worker'}]});` });
      await vi.waitFor(async () => { await h.runtime.tick(); expect(h.adapter.runs).toHaveLength(1); }, { timeout: 20_000, interval: 30 });
      const main = { kind: 'main' as const, scopeId: 'test', workflowId: h.state().workflowId };
      const added = await h.runtime.kernel.call(main, 'staff_swarm', { operationId: randomUUID(), add: ['w1'], workspace: true }) as { workspaces: Array<{ name: string; workspace: string }> };
      const id = added.workspaces[0]!.workspace;
      const path = join(h.dir, 'worktrees', h.state().workflowId, id);
      await written(join(path, 'value.txt'));
      await vi.waitFor(async () => {
        await h.runtime.tick();
        const taskId = h.state().swarms![0]!.members.find(member => member.name === 'w1')!.taskId;
        expect(h.state().tasks.find(task => task.taskId === taskId)?.status).toBe('result_ready');
      }, { timeout: 20_000, interval: 30 });
      await expect(h.call('staff_swarm', { cleanup: ['w1'] })).rejects.toThrow('retire it before cleaning');
      expect(h.state().swarms![0]!.members.find(member => member.name === 'w1')!.workspace).toBe(id);
      await h.call('staff_swarm', { retire: ['w1'] });
      expect(h.state().swarms![0]!.members.find(member => member.name === 'w1')!.stopped).toBe('retired');
      const cleaned = await h.call('staff_swarm', { cleanup: ['w1'] }) as { cleaned: string[] };
      expect(cleaned.cleaned).toEqual(['w1']);
      const member = h.state().swarms![0]!.members.find(item => item.name === 'w1')!;
      expect(member.workspace).toBeUndefined();
      expect(member.cleaned).toBe(true);
      await expect(access(path)).rejects.toBeTruthy();
      // A second cleanup names nothing rather than failing.
      expect((await h.call('staff_swarm', { cleanup: 'retired' }) as { cleaned: string[] }).cleaned).toEqual([]);
    } finally { release(); }
  }, 60_000);
});
