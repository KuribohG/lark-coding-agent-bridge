import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { callWorkflow, WorkflowRuntime } from '../src';
import { WorkflowKernel } from '../src/engine/kernel';
import { workspaceCommand } from '../src/engine/workspace-process';
import { WorkflowWorkspaces } from '../src/engine/workspaces';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';
import type { LandReport, WorkspaceBinding, WorkspaceLanding } from '../src/engine/workspace-types';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, signal());
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const node = (code: string) => ({ argv: [process.execPath, '-e', code] });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-landing-'));
  closes.push(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'shared.txt'), 'baseline\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const base = await git(repo, 'rev-parse', 'HEAD');
  const root = { scopeId: 'scope', profile: 'test', agentKind: 'codex' as const, cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'root', modelSettings: {} };
  const kernel = new WorkflowKernel(':memory:', { resolveRoot: async () => root, execute: async () => ({ status: 'completed' }), wakeMain: async () => {} });
  closes.push(() => kernel.close());
  await kernel.call({ kind: 'main', scopeId: 'scope', allowStart: true }, 'run_script', { operationId: 'start', goal: 'test', plan: 'test landing', script: 'return null;' });
  const state = kernel.state('scope')!;
  const manager = new WorkflowWorkspaces(join(dir, 'workspaces.sqlite'), join(dir, 'worktrees'));
  closes.push(() => manager.close());
  const ctx = { state, signal: signal() };
  const op = <T>(kind: string, key: string, args: object = {}) => manager.perform(ctx, { kind, key, ...args }) as Promise<T>;
  /** A member's worktree with a turn running in it. */
  const member = async (name: string) => {
    const ws = await op<WorkspaceBinding>('create', name);
    manager.begin(ws, name);
    return { ws, land: () => manager.land(ctx, { workspace: ws.id, taskId: name }),
      commit: async (file: string, content: string) => { await writeFile(join(ws.path, file), content); await git(ws.path, 'add', '.'); await git(ws.path, 'commit', '-m', file); } };
  };
  const configure = (checks: object[] = [node('process.exit(0)')], options: object = {}) => op<WorkspaceLanding>('landing', 'landing-' + randomUUID(), { checks, ...options });
  const head = async () => git(repo, 'rev-parse', (await configure()).targetRef);
  return { dir, repo, base, state, manager, ctx, op, member, configure, head };
}

describe('landing members\' work on a shared branch', () => {
  it('lands many worktrees at once without losing or reordering anyone\'s commits', async () => {
    const h = await fixture();
    const landing = await h.configure([node('setTimeout(()=>{},50+Math.random()*150)')]);
    const members = await Promise.all(Array.from({ length: 8 }, (_, index) => h.member('m' + index)));
    await Promise.all(members.map((member, index) => member.commit(`file-${index}.txt`, `${index}\n`)));
    const reports = await Promise.all(members.map(member => member.land()));
    expect(reports.map(report => report.status)).toEqual(Array(8).fill('landed'));
    const files = (await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n');
    expect(files).toEqual(expect.arrayContaining(members.map((_, index) => `file-${index}.txt`)));
    // Rebasing keeps the branch linear: one commit per member on top of the baseline.
    expect(await git(h.repo, 'rev-list', '--count', `${h.base}..${landing.targetRef}`)).toBe('8');
    expect(await git(h.repo, 'rev-list', '--min-parents=2', landing.targetRef)).toBe('');
    expect(await git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
    // Landing again is a no-op, and a landed worktree may be removed.
    expect(await members[0]!.land()).toMatchObject({ status: 'landed', commits: 0 });
    h.manager.end(members[0]!.ws, (await h.manager.binding(h.state.root, h.state.workflowId, members[0]!.ws.id, signal())).busy!.token);
    expect(await h.op('cleanup', 'clean', { workspace: members[0]!.ws.id })).toMatchObject({ removed: true });
  }, 60_000);

  it('hands a conflict back with the worktree as it was submitted', async () => {
    const h = await fixture(); await h.configure();
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    await a.commit('shared.txt', 'A\n'); await b.commit('shared.txt', 'B\n');
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1 });
    const submitted = await git(b.ws.path, 'rev-parse', 'HEAD');
    const report = await b.land();
    expect(report).toMatchObject({ status: 'conflict', targetCommit: await h.head() });
    expect((report as { detail: string }).detail).toContain('shared.txt');
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(submitted);
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
    // The member resolves it in its own worktree and submits again.
    await git(b.ws.path, 'reset', '--hard', await h.head()); await b.commit('shared.txt', 'A and B\n');
    expect(await b.land()).toMatchObject({ status: 'landed', commits: 1 });
  }, 60_000);

  it('rejects work that fails the checks, or checks that leave files behind, and lands the repair', async () => {
    const h = await fixture();
    await h.configure([node('process.exit(0)'), node(`const fs=require('fs');if(fs.existsSync('bad.txt')){console.error('bad.txt present');process.exit(3)}`)]);
    const a = await h.member('a'); await a.commit('bad.txt', 'x\n');
    const failed = await a.land() as Extract<LandReport, { status: 'check_failed' }>;
    expect(failed).toMatchObject({ status: 'check_failed', commands: [{ code: 0 }, { code: 3 }] });
    expect(failed.commands[1]!.stderr).toContain('bad.txt present');
    expect(await git(h.repo, 'rev-parse', '--verify', '--quiet', (await h.configure()).targetRef).catch(() => 'none')).toBe('none');
    await git(a.ws.path, 'rm', '-q', 'bad.txt'); await a.commit('good.txt', 'y\n');
    await h.configure([node(`require('fs').writeFileSync('left-behind', '')`)]);
    expect(await a.land()).toMatchObject({ status: 'check_failed', reason: expect.stringContaining('untracked') });
    await rm(join(a.ws.path, 'left-behind'));
    await h.configure();
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 2 });
  }, 60_000);

  it('strict landings check the commit that lands; relaxed ones accept a clean rebase after passing checks', async () => {
    for (const strict of [true, false]) {
      const h = await fixture();
      // The check passes only while the other member's file is absent, so only a re-check on the new head can notice it.
      await h.configure([node(`const fs=require('fs');if(fs.existsSync('mine.txt')&&fs.existsSync('theirs.txt'))process.exit(1);setTimeout(()=>{},fs.existsSync('mine.txt')?600:0)`)], { strict });
      const [slow, fast] = await Promise.all([h.member('slow'), h.member('fast')]);
      await slow.commit('mine.txt', '1\n'); await fast.commit('theirs.txt', '2\n');
      const pending = slow.land();
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(await fast.land()).toMatchObject({ status: 'landed' });
      expect((await pending).status).toBe(strict ? 'check_failed' : 'landed');
    }
  }, 60_000);

  it('requires the task running in the worktree and a configured landing', async () => {
    const h = await fixture(); const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    await expect(a.land()).rejects.toThrow('not configured');
    await h.configure();
    await expect(h.manager.land(h.ctx, { workspace: a.ws.id, taskId: 'someone-else' })).rejects.toThrow('running in this worktree');
    await expect(h.op('landing', 'bad', { checks: [] })).rejects.toThrow('1–4');
    // A submission repeated while the first is in flight joins it.
    const [first, second] = [a.land(), a.land()];
    expect(await first).toBe(await second);
  }, 60_000);
});

describe('submit_work', () => {
  function harness(land: (input: { workspace: string; taskId: string }, signal: AbortSignal) => Promise<unknown>) {
    let now = 1_000_000;
    const root: WorkflowRoot = { scopeId: 'submit-test', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace', policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
    const requests: WorkflowWorkerRequest[] = [];
    const kernel = new WorkflowKernel(':memory:', { resolveRoot: async () => root, wakeMain: async () => {}, resolveWorkspace: async () => {},
      land: async (_state, input, signal) => land(input, signal),
      execute: async request => { requests.push(request); request.onRun('run-' + request.attemptId); request.onSession('native');
        return new Promise<WorkflowWorkerResult>(resolve => request.signal.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true })); } }, () => now);
    closes.push(() => kernel.close());
    const state = () => kernel.state(root.scopeId)!;
    const send = (request: WorkflowWorkerRequest, method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'worker', scopeId: root.scopeId,
      workflowId: state().workflowId, taskId: request.task.taskId, attemptId: request.attemptId }, method, { operationId: randomUUID(), ...args });
    return { kernel, state, requests, send, advance: (ms: number) => { now += ms; },
      start: async (workspace?: string) => {
        await kernel.call({ kind: 'main', scopeId: root.scopeId, allowStart: true }, 'run_script', { operationId: 'start', goal: 'Fix bugs', plan: 'Members claim and land.', script: 'return null;' });
        kernel.beginScript(root.scopeId, state().workflowId);
        const run = state().script!.runId;
        await kernel.scriptWork(root.scopeId, state().workflowId, run, { kind: 'enqueue', key: 'bug-1', title: 'Bug 1', input: {} });
        await kernel.scriptAgent(root.scopeId, state().workflowId, run, { key: 'turn', member: 'fixer', prompt: 'Fix a bug', ...(workspace ? { workspace } : {}) });
        await kernel.tick(); await vi.waitFor(() => expect(requests).toHaveLength(1));
        return requests[0]!;
      } };
  }
  type Grant = { claimId: string; generation: number };

  it('completes the claimed item once the work has landed and answers a repeat from the record', async () => {
    const lands: string[] = [];
    const h = harness(async input => { lands.push(input.workspace); return { status: 'landed', targetRef: 'refs/heads/x', headCommit: 'abc', commits: 2 }; });
    const request = await h.start('ws-1');
    const grant = await h.send(request, 'claim_work') as Grant;
    const operationId = 'submit-1';
    const landed = await h.send(request, 'submit_work', { operationId, claimId: grant.claimId, generation: grant.generation });
    expect(landed).toMatchObject({ status: 'landed', headCommit: 'abc', commits: 2, item: { status: 'completed' } });
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed', result: { headCommit: 'abc', commits: 2 } });
    expect(await h.send(request, 'submit_work', { operationId, claimId: grant.claimId, generation: grant.generation })).toMatchObject({ status: 'landed', item: { status: 'completed' } });
    expect(lands).toEqual(['ws-1']);
    // Without a claim it only lands.
    expect(await h.send(request, 'submit_work')).toMatchObject({ status: 'landed', commits: 2 });
    expect(lands).toHaveLength(2);
  });

  it('leaves the claim with the member when the landing is rejected, and keeps it leased while checks run', async () => {
    let release!: (report: unknown) => void;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    const request = await h.start('ws-1');
    const grant = await h.send(request, 'claim_work', { leaseMs: 5000 }) as Grant;
    const pending = h.send(request, 'submit_work', { claimId: grant.claimId, generation: grant.generation, result: { fixed: true } });
    await vi.waitFor(() => expect(release).toBeDefined());
    // Longer than the lease the member asked for: submitting extended it.
    h.advance(60_000); await h.kernel.tick();
    release({ status: 'check_failed', targetRef: 'refs/heads/x', targetCommit: 'abc', headCommit: 'def', commands: [{ argv: ['test'], code: 1, stdout: '', stderr: 'boom' }] });
    expect(await pending).toMatchObject({ status: 'check_failed', commands: [{ stderr: 'boom' }] });
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'claimed' });
    expect(await h.send(request, 'release_claim', { claimId: grant.claimId, generation: grant.generation, reason: 'cannot fix' })).toMatchObject({ status: 'pending' });
  });

  it('refuses members without a worktree and stale claims before touching Git', async () => {
    const land = vi.fn(async () => ({ status: 'landed' }));
    const bare = harness(land);
    const request = await bare.start();
    const grant = await bare.send(request, 'claim_work') as Grant;
    await expect(bare.send(request, 'submit_work', { claimId: grant.claimId, generation: grant.generation })).rejects.toThrow('managed worktree');
    const h = harness(land);
    const second = await h.start('ws-1');
    const held = await h.send(second, 'claim_work') as Grant;
    await expect(h.send(second, 'submit_work', { claimId: held.claimId, generation: held.generation + 1 })).rejects.toThrow('stale');
    await expect(h.send(second, 'submit_work', { result: 1 })).rejects.toThrow('claimId');
    await expect(h.send(second, 'submit_work', { extra: 1 })).rejects.toThrow('Unsupported');
    expect(land).not.toHaveBeenCalled();
  });
});

describe('claim, fix and land through the runtime', () => {
  it('runs the packaged example: members claim bugs, commit in their worktrees and land them over IPC', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-claim-land-'));
    closes.push(() => rm(dir, { recursive: true, force: true }));
    const repo = join(dir, 'repo'); await mkdir(repo);
    await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
    await writeFile(join(repo, 'README'), 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'main', modelSettings: {} };
    const rejected: string[] = [];
    const runtime = new WorkflowRuntime({ path: join(dir, 'workflows.sqlite'), resolveRoot: async () => root, wakeMain: async () => {}, authorizeWorkspace: async () => {},
      runner: { async start(spec) {
        await spec.validateBeforeRun();
        const cwd = spec.workspace!.path;
        expect(spec.systemPrompt).toContain('Landing branch: bridge-workflow/');
        /** One turn of a fixer: claim until the queue is empty. */
        const work = (async () => {
          for (;;) {
            const grant = await callWorkflow('claim_work', { operationId: randomUUID() }, spec.env) as { claimId: string; generation: number; item: { key: string } } | null;
            if (!grant) return;
            const claim = { claimId: grant.claimId, generation: grant.generation };
            const branch = (await git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/heads/bridge-workflow')).split('\n')[0];
            if (branch) await git(cwd, 'rebase', branch);
            // Every fixer appends to the same file, so concurrent fixes conflict and must be redone on the new head.
            for (;;) {
              await writeFile(join(cwd, 'fixed.txt'), (await readFile(join(cwd, 'fixed.txt'), 'utf8').catch(() => '')) + grant.item.key + '\n');
              await git(cwd, 'add', '.'); await git(cwd, '-c', 'user.name=Fixer', '-c', 'user.email=fixer@localhost', 'commit', '-m', grant.item.key);
              const report = await callWorkflow('submit_work', { operationId: randomUUID(), ...claim, result: { fixed: grant.item.key } }, spec.env) as { status: string; targetCommit: string };
              if (report.status === 'landed') break;
              rejected.push(report.status);
              await git(cwd, 'reset', '--hard', report.targetCommit);
            }
          }
        })();
        return { runId: randomUUID(), result: work.then(() => 'completed' as const, () => 'failed' as const), stop: async () => {}, waitForExit: async () => { await work.catch(() => {}); return true; },
          stopReason: () => undefined,
          async *events() {
            yield { type: 'session' as const, nativeSessionId: spec.resume?.id ?? randomUUID() };
            try { await work; yield { type: 'final_text' as const, text: 'queue drained' }; yield { type: 'done' as const, normal: true }; }
            catch (error) { yield { type: 'error' as const, message: String(error) }; yield { type: 'done' as const, normal: false }; }
          } };
      } } });
    await runtime.start(); closes.push(() => runtime.close());
    const main = runtime.bindMain(root.scopeId, 'start');
    const keys = Array.from({ length: 12 }, (_, index) => `bug-${index}`);
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'Fix bugs', plan: 'Four fixers claim twelve bugs and land each fix.', maxConcurrent: 4, maxAgents: 64,
      script: await readFile(new URL('../../../workflow-definitions/scripted/examples/claim-and-land.js', import.meta.url), 'utf8'),
      args: { members: 4, items: keys.map(key => ({ key, title: key })), checks: [{ argv: [process.execPath, '-e', `if(!require('fs').existsSync('fixed.txt'))process.exit(1)`] }] } }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script?.status).not.toBe('running'); }, { timeout: 100_000, interval: 100 });
    const state = runtime.kernel.state(root.scopeId)!;
    expect(state.script).toMatchObject({ status: 'result_ready' });
    const result = JSON.parse(state.artifacts.find(artifact => artifact.ref === state.script?.resultRef)!.text!) as { branch: string; queues: Record<string, unknown> };
    expect(result.queues).toMatchObject({ default: { completed: 12 } });
    expect(state.workQueue!.items.map(item => item.result)).toEqual(expect.arrayContaining(keys.map(key => ({ fixed: key }))));
    // Every fix is on the branch exactly once, the history is linear, and the original checkout never moved.
    expect((await git(repo, 'show', `${result.branch}:fixed.txt`)).split('\n').sort()).toEqual([...keys].sort());
    expect(await git(repo, 'rev-list', '--count', `main..${result.branch}`)).toBe('12');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'main'));
    expect(rejected.every(status => status === 'conflict')).toBe(true);
  }, 120_000);
});
