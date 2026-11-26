import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { callWorkflow, WorkflowRuntime } from '../src';
import { WorkflowKernel } from '../src/engine/kernel';
import { replaceWorkflowState } from '../src/engine/kernel-store';
import { nodeProcesses, workspaceCommand } from '../src/engine/workspace-process';
import type { WorkflowProcesses } from '../src/engine/ports';
import { CLONE_REMOTE, WorkflowWorkspaces, type TrainTiming } from '../src/engine/workspaces';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult } from '../src/engine/types';
import type { LandingChange, LandReport, LandSubmitted, WorkspaceBinding, WorkspaceLanding } from '../src/engine/workspace-types';
import { LARGE_PATHS, largeCommit, printed } from './helpers/large-tree';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, signal());
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const node = (code: string) => ({ argv: [process.execPath, '-e', code] });

async function fixture(timing: Partial<TrainTiming> = {}, processes?: WorkflowProcesses) {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-landing-'));
  closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
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
  const manager = new WorkflowWorkspaces(join(dir, 'workspaces.sqlite'), join(dir, 'worktrees'), processes, timing);
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
  /** A check that records where it ran and, with a gate, waits until the gate is opened. */
  const log = join(dir, 'checks.log'), gate = join(dir, 'gate');
  const logged = (extra = '', gated = false) => node(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},process.cwd()+'\\n');${extra};`
    + (gated ? `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(t)},10)` : ''));
  const runs = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const waiting = () => [...(manager as unknown as { trains: Map<string, { queue: unknown[] }> }).trains.values()].reduce((total, train) => total + train.queue.length, 0);
  /** Holds the first train at its checks until `count` more submissions wait behind it, so they share the next train. */
  const together = async (count: number, submit: () => Promise<LandReport>[]) => {
    const blocker = await member('blocker-' + randomUUID()); await blocker.commit(`blocker-${randomUUID()}.txt`, 'x\n');
    await rm(gate, { force: true });
    const before = (await runs()).length, first = blocker.land();
    await vi.waitFor(async () => expect(await runs()).toHaveLength(before + 1), { timeout: 20_000, interval: 20 });
    const rest = submit();
    await vi.waitFor(() => expect(waiting()).toBe(count), { timeout: 20_000, interval: 20 });
    await writeFile(gate, '');
    expect(await first).toMatchObject({ status: 'landed' });
    return Promise.all(rest);
  };
  return { dir, repo, base, state, manager, ctx, op, member, configure, head, logged, runs, together };
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
    await h.configure();
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 2 });
  }, 60_000);

  it('carries the submissions that wait onto one train and checks them once', async () => {
    const h = await fixture();
    const landing = await h.configure([h.logged('', true)]);
    const members = await Promise.all(Array.from({ length: 6 }, (_, index) => h.member('m' + index)));
    await Promise.all(members.map((member, index) => member.commit(`file-${index}.txt`, `${index}\n`)));
    const reports = await h.together(6, () => members.map(member => member.land()));
    expect(reports.map(report => report.status)).toEqual(Array(6).fill('landed'));
    // One run for the train that was held, one for the six behind it; none of them in a member's worktree.
    const runs = await h.runs();
    expect(runs).toHaveLength(2);
    expect(new Set(runs).size).toBe(1);
    expect(members.map(member => member.ws.path)).not.toContain(runs[0]);
    expect(await git(h.repo, 'rev-list', '--count', `${h.base}..${landing.targetRef}`)).toBe('7');
    expect(await git(h.repo, 'rev-list', '--min-parents=2', landing.targetRef)).toBe('');
    // Every worktree was moved to the branch head, so the next fix starts from what everyone landed.
    for (const member of members) expect(await git(member.ws.path, 'rev-parse', 'HEAD')).toBe(await h.head());
  }, 60_000);

  it('finds the submission that breaks a train, lands the ones before it and carries the rest on the next', async () => {
    const h = await fixture();
    // Passes only while mine.txt and theirs.txt are not both there: each passes alone, the two together do not.
    const landing = await h.configure([h.logged(`if(fs.existsSync('mine.txt')&&fs.existsSync('theirs.txt')){console.error('both present');process.exit(1)}`, true)]);
    const names = ['mine.txt', 'theirs.txt', 'other-1.txt', 'other-2.txt', 'other-3.txt'];
    const members = await Promise.all(names.map((_, index) => h.member('m' + index)));
    await Promise.all(members.map((member, index) => member.commit(names[index]!, 'x\n')));
    const reports = await h.together(5, () => members.map(member => member.land()));
    const failed = reports.slice(0, 2).filter(report => report.status === 'check_failed') as Array<Extract<LandReport, { status: 'check_failed' }>>;
    expect(failed).toHaveLength(1);
    expect(reports.filter(report => report.status === 'landed')).toHaveLength(4);
    expect(failed[0]!.commands[0]!.stderr).toContain('both present');
    const files = (await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n');
    expect(files).toEqual(expect.arrayContaining(names.slice(2)));
    expect(files.filter(file => file === 'mine.txt' || file === 'theirs.txt')).toHaveLength(1);
    // The branch only ever pointed at commits the checks passed on, and the loser is left on the commits that failed.
    const loser = members[reports.indexOf(failed[0]!)]!;
    expect(await git(loser.ws.path, 'rev-parse', 'HEAD')).toBe(failed[0]!.headCommit);
    expect(await git(loser.ws.path, 'rev-parse', 'HEAD~1')).toBe(failed[0]!.targetCommit);
    expect((await git(loser.ws.path, 'ls-files')).split('\n')).toEqual(expect.arrayContaining(['mine.txt', 'theirs.txt']));
    expect((await h.runs()).length).toBeLessThanOrEqual(1 + 4 + 2);
  }, 60_000);

  it('reports a clash between two submissions on one train as a conflict with what landed', async () => {
    const h = await fixture(); await h.configure([h.logged('', true)]);
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    await a.commit('shared.txt', 'A\n'); await b.commit('shared.txt', 'B\n');
    const reports = await h.together(2, () => [a.land(), b.land()]);
    expect(reports.map(report => report.status).sort()).toEqual(['conflict', 'landed']);
    const conflict = reports.find(report => report.status === 'conflict') as Extract<LandReport, { status: 'conflict' }>;
    expect(conflict.targetCommit).toBe(await h.head());
    expect(conflict.detail).toContain('shared.txt');
  }, 60_000);

  it('prechecks each submission in its own worktree before it may board', async () => {
    const h = await fixture();
    await h.configure([h.logged()], { precheck: [node(`if(require('fs').existsSync('bad.txt')){console.error('precheck: bad.txt');process.exit(2)}`)] });
    const a = await h.member('a'); await a.commit('bad.txt', 'x\n');
    const failed = await a.land() as Extract<LandReport, { status: 'check_failed' }>;
    expect(failed).toMatchObject({ status: 'check_failed', commands: [{ code: 2 }] });
    expect(failed.commands[0]!.stderr).toContain('precheck: bad.txt');
    expect(await h.runs()).toEqual([]);
    await git(a.ws.path, 'rm', '-q', 'bad.txt'); await a.commit('good.txt', 'y\n');
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 2 });
    expect(await h.runs()).toHaveLength(1);
  }, 60_000);

  it('lets the checks print as much as they like and reports the end of it', async () => {
    const h = await fixture();
    const noisy = (code: number) => node(`process.stdout.write('x'.repeat(3e6)+'last line');process.stderr.write('e'.repeat(3e6)+'last error');process.exitCode=${code}`);
    await h.configure([noisy(0)], { precheck: [noisy(0)] });
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1 });
    await h.configure([noisy(3)]);
    const b = await h.member('b'); await b.commit('b.txt', 'b\n');
    const failed = await b.land() as Extract<LandReport, { status: 'check_failed' }>;
    expect(failed).toMatchObject({ status: 'check_failed', commands: [{ code: 3 }] });
    const [command] = failed.commands;
    expect([command!.stdout.length, command!.stdout.endsWith('xlast line'), command!.stderr.endsWith('elast error')]).toEqual([4000, true, true]);
  }, 60_000);

  // Windows cannot check out paths as long as the ones that make this change large.
  it.skipIf(process.platform === 'win32')('screens and lands a change that names more paths than a command may list whole', async () => {
    const h = await fixture();
    await h.configure([h.logged('', true)], { protect: [{ paths: ['bulk/0'] }] });
    const large = await h.member('large');
    await git(large.ws.path, 'reset', '--hard', largeCommit(large.ws.path, h.base));
    expect(printed(large.ws.path, 'diff', '--name-only', '-z', h.base, 'HEAD')).toBeGreaterThan(2_000_000);
    // Every path is matched against the protected ones, and the report holds the first of those that are.
    const rejected = await large.land() as Extract<LandReport, { status: 'rejected' }>;
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.stringContaining('150 changed path(s) are protected') });
    expect(rejected.files).toHaveLength(64);
    // Behind another landing its commit is picked onto the new head, which prints a line for every file it adds.
    await h.configure([h.logged('', true)], { protect: [{ paths: ['expected'] }] });
    const [report] = await h.together(1, () => [large.land()]);
    expect(report).toMatchObject({ status: 'landed', commits: 1 });
    expect(await git(h.repo, 'cat-file', '-t', `${await h.head()}:${LARGE_PATHS.at(-1)}`)).toBe('blob');
  }, 180_000);

  it('rejects changes to protected paths except from the worktrees a rule allows', async () => {
    const h = await fixture();
    const [fixer, keeper] = await Promise.all([h.member('fixer'), h.member('keeper')]);
    const protect = [{ paths: ['expected', '**/*.golden', 'scope.json'], allow: [keeper.ws.id] }];
    await h.configure([h.logged()], { protect });
    await mkdir(join(fixer.ws.path, 'expected')); await mkdir(join(fixer.ws.path, 'src/deep'), { recursive: true });
    await fixer.commit('expected/case-1.txt', 'x\n'); await fixer.commit('src/deep/out.golden', 'x\n'); await fixer.commit('src/fix.txt', 'x\n');
    const rejected = await fixer.land() as Extract<LandReport, { status: 'rejected' }>;
    expect(rejected).toMatchObject({ status: 'rejected', files: ['expected/case-1.txt', 'src/deep/out.golden'] });
    expect(await h.runs()).toEqual([]);
    // A path that merely starts with a protected name is not covered, and the allowed worktree may change them all.
    await git(fixer.ws.path, 'reset', '-q', '--hard', h.base); await fixer.commit('expected-notes.txt', 'x\n'); await fixer.commit('scope.json.bak', 'x\n');
    expect(await fixer.land()).toMatchObject({ status: 'landed', commits: 2 });
    await mkdir(join(keeper.ws.path, 'expected')); await keeper.commit('expected/case-1.txt', 'x\n'); await keeper.commit('scope.json', '{}\n');
    expect(await keeper.land()).toMatchObject({ status: 'landed', commits: 2 });
    // Deleting or renaming a protected file is a change to it.
    await git(fixer.ws.path, 'reset', '-q', '--hard', await h.head()); await h.configure([h.logged()], { protect });
    await git(fixer.ws.path, 'mv', 'scope.json', 'moved.json'); await git(fixer.ws.path, 'commit', '-q', '-m', 'move');
    expect(await fixer.land()).toMatchObject({ status: 'rejected', files: ['scope.json'] });
    await expect(h.configure([h.logged()], { protect: [{ paths: ['../outside'] }] })).rejects.toThrow('relative to the repository root');
    await expect(h.configure([h.logged()], { protect: [{ paths: [] }] })).rejects.toThrow('protect rule');
    await expect(h.configure([h.logged()], { strict: false })).rejects.toThrow('Unsupported');
  }, 60_000);

  it('makes worktrees from a repository other than the workflow cwd when the script names it', async () => {
    const h = await fixture();
    const other = join(h.dir, 'other'); await mkdir(join(other, 'sub'), { recursive: true });
    await git(other, 'init', '-b', 'main'); await git(other, 'config', 'user.name', 'Test'); await git(other, 'config', 'user.email', 'test@localhost');
    await writeFile(join(other, 'sub/readme'), 'other\n'); await git(other, 'add', '.'); await git(other, 'commit', '-m', 'base');
    await expect(h.op('create', 'relative', { repo: 'other' })).rejects.toThrow('absolute');
    await expect(h.op('create', 'inside', { repo: join(other, 'sub') })).rejects.toThrow('root of a Git checkout');
    const landing = await h.configure();
    const ws = await h.op<WorkspaceBinding>('create', 'elsewhere', { repo: other });
    // The binding names the checkout by its real path; the temporary directory may be reached through a link or a short name.
    expect(ws.repository).toBe(await realpath(other));
    h.manager.begin(ws, 'task');
    await writeFile(join(ws.path, 'fix.txt'), 'x\n'); await git(ws.path, 'add', '.'); await git(ws.path, 'commit', '-m', 'fix');
    expect(await h.manager.land(h.ctx, { workspace: ws.id, taskId: 'task' })).toMatchObject({ status: 'landed', commits: 1 });
    expect(await git(other, 'ls-tree', '--name-only', landing.targetRef)).toContain('fix.txt');
    // The branch is in the repository the worktree came from; the workflow's own checkout has none.
    expect(await git(h.repo, 'for-each-ref', 'refs/heads/bridge-workflow')).toBe('');
    // Removing the last member worktree of a repository takes the train's worktree with it.
    expect(await git(other, 'worktree', 'list', '--porcelain')).toContain('/train-');
    h.manager.end(ws, (await h.manager.binding(h.state.root, h.state.workflowId, ws.id, signal())).busy!.token);
    expect(await h.op('cleanup', 'clean', { workspace: ws.id })).toMatchObject({ removed: true });
    expect(await git(other, 'worktree', 'list', '--porcelain')).not.toContain('/train-');
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

describe('a landing branch that only the queue moves', () => {
  /** Commits a file straight onto the landing branch, the way a checkout of it would, and leaves the branch free again. */
  async function outside(h: Awaited<ReturnType<typeof fixture>>, targetRef: string, file: string) {
    const path = join(h.dir, 'outside-' + randomUUID());
    await git(h.repo, 'worktree', 'add', '-q', path, targetRef.replace('refs/heads/', ''));
    await mkdir(join(path, file, '..'), { recursive: true });
    await writeFile(join(path, file), 'outside\n'); await git(path, 'add', '.'); await git(path, 'commit', '-q', '-m', 'outside ' + file);
    await git(path, 'checkout', '-q', '--detach');
    return git(path, 'rev-parse', 'HEAD');
  }
  const noBadFile = node(`if(require('fs').existsSync('bad.txt')){console.error('bad.txt is here');process.exit(3)}`);
  const configured = async (h: Awaited<ReturnType<typeof fixture>>, options: object = {}) => {
    const landing = await h.configure([h.logged(), noBadFile], options);
    const first = await h.member('first'); await first.commit('first.txt', 'x\n');
    expect(await first.land()).toMatchObject({ status: 'landed' });
    return { landing, landed: await git(h.repo, 'rev-parse', landing.targetRef) };
  };

  it('names the queue in the reflog of every move it makes', async () => {
    const h = await fixture(); const { landing } = await configured(h);
    expect(await git(h.repo, 'reflog', 'show', '--format=%gs', '-1', landing.targetRef)).toMatch(/^bridge-workflow: landed 1 submission\(s\), 1 commit\(s\) from [0-9a-f]{8}$/);
  }, 60_000);

  it('adopts commits from outside that pass the checks and reports them once', async () => {
    const h = await fixture(); const { landing, landed } = await configured(h);
    const stray = await outside(h, landing.targetRef, 'stray.txt');
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    await a.commit('a.txt', 'a\n'); await b.commit('b.txt', 'b\n');
    const before = (await h.runs()).length;
    const report = await a.land();
    expect(report).toMatchObject({ status: 'landed', commits: 1 });
    expect(report.notice).toContain('1 个提交未经 submit_work 进入');
    expect(report.notice).toContain(`${landed.slice(0, 10)}..${stray.slice(0, 10)}`);
    // One run looked at the outside commit, one checked the train.
    expect(await h.runs()).toHaveLength(before + 2);
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n')).toEqual(expect.arrayContaining(['stray.txt', 'a.txt']));
    expect((await b.land()).notice).toBeUndefined();
    expect(await h.runs()).toHaveLength(before + 3);
  }, 60_000);

  it('halts on outside commits that fail the checks, before a member is rebased onto them, until the branch is restored', async () => {
    const h = await fixture(); const { landing, landed } = await configured(h);
    const bad = await outside(h, landing.targetRef, 'bad.txt');
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    const mine = await git(a.ws.path, 'rev-parse', 'HEAD');
    const before = (await h.runs()).length;
    const halted = await a.land() as Extract<LandReport, { status: 'halted' }>;
    expect(halted).toMatchObject({ status: 'halted', targetCommit: bad });
    expect(halted.reason).toContain('fail the landing checks');
    expect(halted.notice).toContain('落地已停止');
    expect(halted.notice).toContain('bad.txt is here');
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(mine);
    // The verdict stands for this commit: asking again runs nothing.
    expect(await a.land()).toMatchObject({ status: 'halted', notice: halted.notice });
    expect(await h.runs()).toHaveLength(before + 1);
    const view = await h.manager.configure(h.ctx, {});
    expect(view).toMatchObject({ changed: false, landing: { branches: [{ head: bad, landed, waiting: 0 }] } });
    expect(view.landing.branches[0]!.halted).toContain('fail the landing checks');
    const restored = await h.manager.configure(h.ctx, { branch: 'restore' });
    expect(restored.settled).toEqual([{ repository: await realpath(h.repo), branch: 'restored', head: landed, kept: `refs/bridge-workflow/${h.state.workflowId}/outside/${bad}` }]);
    expect(await git(h.repo, 'rev-parse', landing.targetRef)).toBe(landed);
    expect(await git(h.repo, 'rev-parse', restored.settled![0]!.kept!)).toBe(bad);
    expect(await git(h.repo, 'reflog', 'show', '--format=%gs', '-1', landing.targetRef)).toContain('restored after a move from outside');
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1 });
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n')).not.toContain('bad.txt');
    expect((await h.manager.configure(h.ctx, {})).landing.branches[0]!.halted).toBeUndefined();
  }, 60_000);

  it('halts on outside commits that change protected paths or drop landed work, and lands again once the main agent adopts the branch', async () => {
    const h = await fixture(); const { landing, landed } = await configured(h, { protect: [{ paths: ['expected'] }] });
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    const golden = await outside(h, landing.targetRef, 'expected/case.txt');
    const before = (await h.runs()).length;
    expect(((await a.land()) as Extract<LandReport, { status: 'halted' }>).reason).toContain('protected paths (expected/case.txt)');
    expect(await h.runs()).toHaveLength(before);
    expect(await h.manager.configure(h.ctx, { branch: 'adopt' })).toMatchObject({ settled: [{ branch: 'adopted', head: golden }] });
    expect(await a.land()).toMatchObject({ status: 'landed' });
    // A branch moved back loses what landed on it.
    await git(h.repo, 'update-ref', landing.targetRef, landed);
    const b = await h.member('b'); await b.commit('b.txt', 'b\n');
    expect(((await b.land()) as Extract<LandReport, { status: 'halted' }>).reason).toContain('landed work is missing');
    await git(h.repo, 'update-ref', '-d', landing.targetRef);
    expect(((await b.land()) as Extract<LandReport, { status: 'halted' }>).reason).toContain('was deleted');
    await expect(h.manager.configure(h.ctx, { branch: 'adopt' })).rejects.toThrow('deleted');
    expect(await h.manager.configure(h.ctx, { branch: 'restore' })).toMatchObject({ settled: [{ branch: 'restored' }] });
    expect(await b.land()).toMatchObject({ status: 'landed' });
  }, 60_000);

  it('halts the submissions that wait when the branch moves under a train', async () => {
    const h = await fixture();
    const gate = join(h.dir, 'gate'); await writeFile(gate, '');
    const landing = await h.configure([h.logged('', true), noBadFile]);
    const first = await h.member('first'); await first.commit('first.txt', 'x\n');
    expect(await first.land()).toMatchObject({ status: 'landed' });
    const landed = await git(h.repo, 'rev-parse', landing.targetRef);
    await rm(gate, { force: true });
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    await a.commit('a.txt', 'a\n'); await b.commit('b.txt', 'b\n');
    const before = (await h.runs()).length, held = a.land();
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(before + 1), { timeout: 20_000, interval: 20 });
    const waiting = b.land(), trains = (h.manager as unknown as { trains: Map<string, { queue: unknown[] }> }).trains;
    await vi.waitFor(() => expect([...trains.values()][0]!.queue).toHaveLength(1), { timeout: 20_000, interval: 20 });
    const bad = await outside(h, landing.targetRef, 'bad.txt');
    await writeFile(gate, '');
    // The train that was checking runs again and looks at the branch first: its submission is told the same.
    expect(await held).toMatchObject({ status: 'halted', targetCommit: bad });
    expect(await waiting).toMatchObject({ status: 'halted', targetCommit: bad });
    // It had rebased onto the last landed commit and stays there.
    expect(await git(b.ws.path, 'rev-parse', 'HEAD~1')).toBe(landed);
  }, 60_000);
});

describe('stacking a train', () => {
  /** The Git commands the service runs, by their arguments after its own options. */
  const recorded = () => {
    const calls: string[][] = [];
    const processes: WorkflowProcesses = { ...nodeProcesses, spawn: (command, args, options) => {
      if (command === 'git') calls.push(args.filter((arg, at) => !arg.startsWith('core.') && !arg.startsWith('gc.') && !arg.startsWith('user.') && arg !== '-c' && args[at - 1] !== undefined));
      return nodeProcesses.spawn(command, args, options);
    } };
    return { calls, processes, ran: (name: string) => calls.filter(call => call[0] === name) };
  };
  /** A commit as Git stores it, without the lines that a new commit of the same change gets anew. */
  const kept = async (cwd: string, commit: string) => (await git(cwd, 'cat-file', 'commit', commit)).split('\n').filter(line => !/^(tree|parent|committer) /.test(line)).join('\n');

  it('stacks submissions without picking them into its worktree, and keeps each commit\'s author and message', async () => {
    const git2 = recorded(); const h = await fixture({}, git2.processes);
    const landing = await h.configure([h.logged('', true)]);
    const a = await h.member('a'), b = await h.member('b');
    await a.commit('a.txt', 'a\n');
    await writeFile(join(b.ws.path, 'b.txt'), 'b\n'); await git(b.ws.path, 'add', '.');
    await git(b.ws.path, '-c', 'user.name=Someone Else', '-c', 'user.email=else@example.org', 'commit', '-q', '--date=2001-02-03T04:05:06+0700', '-m', 'Subject of b', '-m', 'Body, with a line\nand   spaces  kept.');
    await git(b.ws.path, 'commit', '-q', '--allow-empty', '-m', 'made empty on purpose');
    const originals = (await git(b.ws.path, 'rev-list', '--reverse', `${h.base}..HEAD`)).split('\n');
    const reports = await h.together(2, () => [a.land(), b.land()]);
    expect(reports).toMatchObject([{ status: 'landed', commits: 1 }, { status: 'landed', commits: 2 }]);
    // Nothing was picked: the commits were merged in the object database, and the worktree only took the stack to check.
    expect(git2.ran('cherry-pick').filter(call => !call.includes('--abort'))).toEqual([]);
    expect(git2.ran('merge-tree').length).toBeGreaterThanOrEqual(3);
    // The blocker of `together`, a, and both commits of b, the empty one too; a and b board in the order they got through.
    const landed = (await git(h.repo, 'log', '--format=%H %s', `${h.base}..${landing.targetRef}`)).split('\n');
    expect(landed).toHaveLength(4);
    expect(await git(h.repo, 'rev-list', '--min-parents=2', landing.targetRef)).toBe('');
    const mine = ['Subject of b', 'made empty on purpose'].map(subject => landed.find(line => line.endsWith(' ' + subject))!.split(' ')[0]!);
    for (const [index, original] of originals.entries()) {
      expect(mine[index]).not.toBe(original);
      expect(await kept(h.repo, mine[index]!)).toBe(await kept(h.repo, original));
    }
    expect(await git(h.repo, 'log', '-1', '--format=%cn <%ce>', mine[0]!)).toBe('Test <test@localhost>');
    expect(await git(h.repo, 'rev-parse', `${mine[1]}~1`)).toBe(mine[0]);
    expect(await git(h.repo, 'diff', '--name-only', mine[0]!, mine[1]!)).toBe('');
    for (const member of [a, b]) expect(await git(member.ws.path, 'rev-parse', 'HEAD')).toBe(await h.head());
  }, 60_000);

  it('leaves out a commit the branch already holds', async () => {
    const h = await fixture(); const landing = await h.configure([h.logged('', true)]);
    const a = await h.member('a'), b = await h.member('b');
    await a.commit('same.txt', 'the same change\n');
    await b.commit('same.txt', 'the same change\n'); await b.commit('b.txt', 'b\n');
    const reports = await h.together(2, () => [a.land(), b.land()]);
    expect(reports.map(report => report.status)).toEqual(['landed', 'landed']);
    expect((await git(h.repo, 'log', '--format=%s', `${h.base}..${landing.targetRef}`)).split('\n').filter(subject => subject === 'same.txt')).toHaveLength(1);
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n')).toEqual(expect.arrayContaining(['same.txt', 'b.txt']));
  }, 60_000);

  it('picks in its worktree what is not a plain line of commits, and hands a merge back as a conflict', async () => {
    const git2 = recorded(); const h = await fixture({}, git2.processes);
    await h.configure([h.logged('', true)]);
    const m = await h.member('m');
    await git(m.ws.path, 'checkout', '-q', '-b', 'side-' + randomUUID()); await m.commit('side.txt', 'side\n');
    const side = await git(m.ws.path, 'rev-parse', 'HEAD');
    await git(m.ws.path, 'checkout', '-q', '--detach', h.base); await m.commit('main.txt', 'main\n');
    await git(m.ws.path, 'merge', '-q', '--no-ff', '-m', 'merge side', side);
    const [report] = await h.together(1, () => [m.land()]);
    expect(report).toMatchObject({ status: 'conflict' });
    expect((report as { detail: string }).detail).toContain('is a merge');
    expect(git2.ran('merge-tree')).toEqual([]);
    expect(git2.ran('cherry-pick').some(call => !call.includes('--abort'))).toBe(true);
  }, 60_000);

  it('picks in its worktree under a Git that cannot merge without one, and asks it only once', async () => {
    const calls: string[][] = [];
    const old: WorkflowProcesses = { ...nodeProcesses, spawn: (command, args, options) => {
      if (command !== 'git' || !args.includes('merge-tree')) return nodeProcesses.spawn(command, args, options);
      calls.push([...args]);
      return nodeProcesses.spawn(process.execPath, ['-e', `process.stderr.write("error: unknown option \`merge-base=x'\\nusage: git merge-tree [--write-tree]\\n");process.exit(129)`], options);
    } };
    const h = await fixture({}, old); const landing = await h.configure([h.logged('', true)]);
    const members = await Promise.all(['a', 'b', 'c'].map(name => h.member(name)));
    await Promise.all(members.map((member, index) => member.commit(`file-${index}.txt`, 'x\n')));
    const reports = await h.together(3, () => members.map(member => member.land()));
    expect(reports.map(report => report.status)).toEqual(['landed', 'landed', 'landed']);
    expect(calls).toHaveLength(1);
    expect(await git(h.repo, 'rev-list', '--count', `${h.base}..${landing.targetRef}`)).toBe('4');
  }, 60_000);
});

describe('a train that fails for a reason of its own', () => {
  /** A landing with one submission landed, so the train's worktree exists; returns that worktree's own Git directory. */
  const started = async (h: Awaited<ReturnType<typeof fixture>>) => {
    const landing = await h.configure([h.logged()]);
    const first = await h.member('first'); await first.commit('first.txt', 'x\n');
    expect(await first.land()).toMatchObject({ status: 'landed' });
    return { landing, own: await git((await h.runs())[0]!, 'rev-parse', '--absolute-git-dir') };
  };
  const retrying = async (h: Awaited<ReturnType<typeof fixture>>) => (await h.manager.configure(h.ctx, {})).landing.branches[0]!.retrying;

  it('keeps the submissions and runs again when another process holds a lock in its worktree', async () => {
    const h = await fixture({ retryDelaysMs: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20] }); const { landing, own } = await started(h);
    // What `git status` in the train's worktree does while it scans the tree.
    await writeFile(join(own, 'index.lock'), '');
    const members = await Promise.all(['a', 'b', 'c'].map(name => h.member(name)));
    await Promise.all(members.map((member, index) => member.commit(`file-${index}.txt`, 'x\n')));
    const landings = members.map(member => member.land());
    await vi.waitFor(async () => expect((await retrying(h))?.failures).toBeGreaterThanOrEqual(2), { timeout: 20_000, interval: 10 });
    expect((await retrying(h))!.reason).toContain('index.lock');
    await rm(join(own, 'index.lock'));
    const reports = await Promise.all(landings);
    expect(reports.map(report => report.status)).toEqual(['landed', 'landed', 'landed']);
    // The main agent hears of it once, with what to tell the members.
    const notices = reports.map(report => report.notice).filter(Boolean);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]).toContain('重跑');
    expect(notices[0]).toContain('成员不应在列车工作树里运行任何命令');
    expect(await retrying(h)).toBeUndefined();
    expect(await git(h.repo, 'rev-list', '--count', `${h.base}..${landing.targetRef}`)).toBe('4');
    const next = await h.member('next'); await next.commit('next.txt', 'x\n');
    expect((await next.land()).notice).toBeUndefined();
  }, 60_000);

  it('removes a lock that a stopped process left behind, and only from its own worktree', async () => {
    const h = await fixture({ retryDelaysMs: [20, 20], staleLockMs: 60_000 }); const { own } = await started(h);
    const lock = join(own, 'index.lock'), old = new Date(Date.now() - 3_600_000);
    await writeFile(lock, ''); await utimes(lock, old, old);
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    const report = await a.land();
    expect(report).toMatchObject({ status: 'landed', commits: 1 });
    expect(report.notice).toContain('引擎已清除遗留的 index.lock');
    await expect(readFile(lock)).rejects.toThrow();
    // A lock in the directory the repository's worktrees share may be held for any of them: it is waited out, never removed.
    const shared = join(h.repo, '.git', `${report.targetRef}.lock`);
    await writeFile(shared, ''); await utimes(shared, old, old);
    const b = await h.member('b'); await b.commit('b.txt', 'b\n');
    await expect(b.land()).rejects.toThrow('failed 3 times in a row');
    expect(await readFile(shared, 'utf8')).toBe('');
    await rm(shared);
    expect(await b.land()).toMatchObject({ status: 'landed', commits: 1 });
  }, 60_000);

  it('writes the index of its worktree anew when it cannot be read', async () => {
    const h = await fixture({ retryDelaysMs: [10, 10, 10] }); const { own } = await started(h);
    await writeFile(join(own, 'index'), 'cut short');
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    const report = await a.land();
    expect(report).toMatchObject({ status: 'landed', commits: 1 });
    expect(report.notice).toContain('index（无法读取，已重建）');
    expect(await git((await h.runs())[0]!, 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('hands the failure back once it has run out of attempts, and says whose fault it is', async () => {
    const h = await fixture({ retryDelaysMs: [10, 10] }); const { own } = await started(h);
    await writeFile(join(own, 'index.lock'), '');
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    const before = (await h.runs()).length;
    await expect(a.land()).rejects.toThrow(/failed 3 times in a row for a reason of its own[^]*index\.lock[^]*Nothing is wrong with your commits/);
    expect(await h.runs()).toHaveLength(before);
    // The lock is still young: it may belong to a process that runs, so it stays.
    await rm(join(own, 'index.lock'));
    const report = await a.land();
    expect(report).toMatchObject({ status: 'landed', commits: 1 });
    expect(report.notice).toContain('把这一批提交退回给了成员');
  }, 60_000);

  it('tells a member that waits where its submission is', async () => {
    const h = await fixture({ retryDelaysMs: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20] });
    const gate = join(h.dir, 'gate'), held = join(h.dir, 'precheck-gate'); await writeFile(gate, ''); await writeFile(held, '');
    const until = (file: string) => node(`const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(file)}))clearInterval(t)},10)`);
    await h.configure([h.logged('', true)], { precheck: [until(held)] });
    const first = await h.member('first'); await first.commit('first.txt', 'x\n');
    expect(await first.land()).toMatchObject({ status: 'landed' });
    const own = await git((await h.runs())[0]!, 'rev-parse', '--absolute-git-dir');
    const a = await h.member('a'), b = await h.member('b'), c = await h.member('c');
    await a.commit('a.txt', 'a\n'); await b.commit('b.txt', 'b\n'); await c.commit('c.txt', 'c\n');
    const where = (member: typeof a, name: string) => h.manager.progress(h.state.workflowId, { workspace: member.ws.id, taskId: name });
    expect(where(a, 'a')).toBeUndefined();
    // In its own worktree until the precheck is through.
    await rm(held); await rm(gate);
    const landA = a.land();
    await vi.waitFor(() => expect(where(a, 'a')).toMatchObject({ stage: 'preparing' }), { timeout: 20_000, interval: 10 });
    await writeFile(held, '');
    // On the train while its checks run; the ones behind it wait in order.
    await vi.waitFor(() => expect(where(a, 'a')).toMatchObject({ stage: 'on_train', waiting: 0, train: { submissions: 1, step: 'checking', checks: 1 } }), { timeout: 20_000, interval: 10 });
    // Whoever is through its own worktree first boards first: b is in the queue before c submits.
    const landB = b.land();
    await vi.waitFor(() => expect(where(b, 'b')).toMatchObject({ stage: 'waiting', position: 1 }), { timeout: 20_000, interval: 10 });
    const landC = c.land();
    await vi.waitFor(() => expect(where(c, 'c')).toMatchObject({ stage: 'waiting', position: 2, waiting: 2, train: { submissions: 1 } }), { timeout: 20_000, interval: 10 });
    expect(where(b, 'b')).toMatchObject({ stage: 'waiting', position: 1 });
    // A train that runs again for a reason of its own says so to those it carries.
    await writeFile(join(own, 'index.lock'), ''); await writeFile(gate, '');
    expect(await landA).toMatchObject({ status: 'landed' });
    await vi.waitFor(() => expect(where(b, 'b')?.retrying?.failures).toBeGreaterThanOrEqual(1), { timeout: 20_000, interval: 10 });
    expect(where(b, 'b')!.retrying!.reason).toContain('index.lock');
    await rm(join(own, 'index.lock'));
    expect((await Promise.all([landB, landC])).map(report => report.status)).toEqual(['landed', 'landed']);
    expect(where(b, 'b')).toBeUndefined();
  }, 60_000);

  it('does not run a check again that ran out of time', async () => {
    const h = await fixture({ retryDelaysMs: [10, 10] });
    await h.configure([{ ...h.logged('setTimeout(()=>{},60000)'), timeoutMs: 300 }]);
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    await expect(a.land()).rejects.toThrow('timed out');
    expect(await h.runs()).toHaveLength(1);
  }, 60_000);
});

describe('changing the landing while the workflow runs', () => {
  const fails = (name: string) => node(`if(require('fs').existsSync(${JSON.stringify(name)})){console.error(${JSON.stringify(name + ' is here')});process.exit(4)}`);

  it('reports the landing and refuses to change one the script has not configured', async () => {
    const h = await fixture();
    await expect(h.manager.configure(h.ctx, {})).rejects.toThrow('not configured');
    const landing = await h.configure([h.logged()], { batch: 4, protect: [{ paths: ['expected'] }] });
    const a = await h.member('a');
    expect(await h.manager.configure(h.ctx, {})).toEqual({ changed: false, landing: { targetRef: landing.targetRef, checks: landing.commands, protect: [{ paths: ['expected'], allow: [] }], batch: 4, async: false, overridden: [],
      branches: [{ repository: await realpath(h.repo), head: null, waiting: 0 }] } });
    await expect(h.manager.configure(h.ctx, { target: 'other' })).rejects.toThrow('Unsupported');
    await expect(h.manager.configure(h.ctx, { reset: false })).rejects.toThrow('reset');
    await expect(h.manager.configure(h.ctx, { branch: 'force' })).rejects.toThrow('branch');
    await expect(h.manager.configure(h.ctx, { checks: [] })).rejects.toThrow('1–4');
    expect(a.ws.id).toBeTruthy();
  }, 60_000);

  it('replaces checks, precheck and batch, adds protected paths, and keeps the changes when the script configures again', async () => {
    const h = await fixture();
    await h.configure([h.logged()], { protect: [{ paths: ['expected'] }] });
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    const change = await h.manager.configure(h.ctx, { checks: [h.logged(), fails('bad.txt')], precheck: [fails('slow.txt')], protect: [{ paths: ['scripts/gates.sh'] }], batch: 2 });
    expect(change).toMatchObject({ changed: true, landing: { batch: 2, overridden: ['checks', 'precheck', 'protect', 'batch'],
      protect: [{ paths: ['expected'] }, { paths: ['scripts/gates.sh'] }] } });
    expect(change.refused).toBeUndefined();
    // The script calls configureLanding again, as it does to name the worktrees a rule allows.
    await h.op('landing', 'landing-again', { checks: [h.logged()], protect: [{ paths: ['expected'], allow: [a.ws.id] }] });
    expect(h.manager.landing(h.state.workflowId)).toMatchObject({ batch: 2, commands: [{}, { argv: fails('bad.txt').argv }], precheck: [{ argv: fails('slow.txt').argv }],
      protect: [{ paths: ['expected'], allow: [a.ws.id] }, { paths: ['scripts/gates.sh'], allow: [] }] });
    await a.commit('slow.txt', 'x\n');
    expect(await a.land()).toMatchObject({ status: 'check_failed', commands: [{ code: 4 }] });
    await git(a.ws.path, 'reset', '-q', '--hard', 'HEAD~1'); await a.commit('bad.txt', 'x\n');
    expect(await a.land()).toMatchObject({ status: 'check_failed', commands: [{ code: 0 }, { code: 4 }] });
    await git(a.ws.path, 'reset', '-q', '--hard', 'HEAD~1'); await mkdir(join(a.ws.path, 'scripts')); await a.commit('scripts/gates.sh', 'exit 0\n');
    expect(await a.land()).toMatchObject({ status: 'rejected', files: ['scripts/gates.sh'] });
    // Single settings go back to the script's; reset drops the rest.
    expect(await h.manager.configure(h.ctx, { precheck: [], protect: [] })).toMatchObject({ changed: true, landing: { overridden: ['checks', 'precheck', 'batch'] } });
    expect(h.manager.landing(h.state.workflowId)!.precheck).toBeUndefined();
    expect(await a.land()).toMatchObject({ status: 'landed' });
    expect(await h.manager.configure(h.ctx, { reset: true })).toMatchObject({ changed: true, landing: { batch: 16, overridden: [] } });
    expect(await h.manager.configure(h.ctx, { reset: true })).toMatchObject({ changed: false });
  }, 60_000);

  it('refuses new checks the landing branch itself fails, and takes them once the repair has landed', async () => {
    const h = await fixture();
    const landing = await h.configure([h.logged()]);
    const a = await h.member('a'); await a.commit('bad.txt', 'x\n');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    const head = await git(h.repo, 'rev-parse', landing.targetRef);
    const refused = await h.manager.configure(h.ctx, { checks: [fails('bad.txt')], batch: 3 });
    expect(refused).toMatchObject({ changed: false, refused: { repository: await realpath(h.repo), headCommit: head, commands: [{ code: 4 }] }, landing: { batch: 16, overridden: [] } });
    expect(refused.refused!.commands![0]!.stderr).toContain('bad.txt is here');
    expect(refused.refused!.reason).toContain('land the repair under the current checks first');
    expect(await h.manager.configure(h.ctx, { precheck: [fails('bad.txt')] })).toMatchObject({ changed: false, refused: { commands: [{ code: 4 }] } });
    expect(await h.manager.configure(h.ctx, { checks: [node(`require('fs').writeFileSync('left-behind','x')`)] })).toMatchObject({ changed: false, refused: { reason: expect.stringContaining('untracked files') } });
    // Under the current checks the repair lands, and then the branch passes the new ones.
    await git(a.ws.path, 'rm', '-q', 'bad.txt'); await git(a.ws.path, 'commit', '-q', '-m', 'repair');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    expect(await h.manager.configure(h.ctx, { checks: [fails('bad.txt')], batch: 3 })).toMatchObject({ changed: true, landing: { batch: 3, overridden: ['checks', 'batch'] } });
    await a.commit('bad.txt', 'x\n');
    expect(await a.land()).toMatchObject({ status: 'check_failed' });
  }, 60_000);

  it('tries new checks between trains, so no submission lands under the old ones meanwhile', async () => {
    const h = await fixture();
    await h.configure([h.logged('', true)]);
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    await a.commit('a.txt', 'a\n'); await b.commit('bad.txt', 'x\n');
    const gate = join(h.dir, 'gate'); await rm(gate, { force: true });
    const first = a.land();
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(1), { timeout: 20_000, interval: 20 });
    // The change waits for the train in progress; the submission behind it is checked with the new commands.
    const change = h.manager.configure(h.ctx, { checks: [fails('bad.txt')] });
    const second = b.land();
    await writeFile(gate, '');
    expect(await first).toMatchObject({ status: 'landed' });
    expect(await change).toMatchObject({ changed: true });
    expect(await second).toMatchObject({ status: 'check_failed', commands: [{ code: 4 }] });
  }, 60_000);
});

describe('a landing that lets members go on', () => {
  /** Submits as submit_work does for a claimed item: resolves once the submission has joined the queue. */
  const handOff = (h: Awaited<ReturnType<typeof fixture>>, member: { ws: WorkspaceBinding }, taskId: string) => {
    let joined!: (info: LandSubmitted) => void;
    const submitted = new Promise<LandSubmitted>(resolve => { joined = resolve; });
    const report = h.manager.land(h.ctx, { workspace: member.ws.id, taskId, submitted: joined });
    return { submitted: Promise.race([submitted, report.then(found => { throw new Error('answered ' + found.status + ' before it joined the queue'); })]), report };
  };

  it('answers once the commits are in the queue, leaves the worktree at the tip of the branch and takes the next submission', async () => {
    const h = await fixture();
    const gate = join(h.dir, 'open');
    const landing = await h.configure([node(`const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(t)},10)`)], { async: true });
    expect(landing).toMatchObject({ async: true });
    const a = await h.member('a'); await a.commit('one.txt', '1\n');
    const head = await git(a.ws.path, 'rev-parse', 'HEAD');
    const first = handOff(h, a, 'a');
    expect(await first.submitted).toEqual({ targetRef: landing.targetRef, targetCommit: h.base, headCommit: head, commits: 1, worktree: 'reset' });
    // The worktree is where a landing would have left it, without the commits that wait.
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('');
    // The next item is submitted from the same worktree while the first still waits, as a submission of its own.
    await a.commit('two.txt', '2\n');
    const second = handOff(h, a, 'a');
    expect(await second.submitted).toMatchObject({ targetCommit: h.base, commits: 1, worktree: 'reset' });
    expect(second.report).not.toBe(first.report);
    await writeFile(join(a.ws.path, 'three.txt'), 'in progress\n');
    await writeFile(gate, '');
    expect(await first.report).toMatchObject({ status: 'landed', commits: 1 });
    expect(await second.report).toMatchObject({ status: 'landed', commits: 1 });
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n')).toEqual(expect.arrayContaining(['one.txt', 'two.txt']));
    // Landing did not reach into the worktree the member has gone on in.
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('?? three.txt');
  }, 60_000);

  it('reports a failed check with commits the member can bring back, and still answers a conflict in its worktree at once', async () => {
    const h = await fixture();
    await h.configure([node(`if(require('fs').existsSync('bad.txt')){console.error('bad.txt present');process.exit(3)}`)], { async: true });
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    await a.commit('bad.txt', 'x\n');
    const handed = handOff(h, a, 'a'), info = await handed.submitted;
    expect(await handed.report).toMatchObject({ status: 'check_failed', commands: [{ code: 3 }] });
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(info.targetCommit);
    await git(a.ws.path, 'cherry-pick', `${info.targetCommit}..${info.headCommit}`);
    expect(await git(a.ws.path, 'ls-files')).toContain('bad.txt');
    // What fails before the queue is answered as ever, with the worktree as it was submitted.
    await b.commit('shared.txt', 'B\n'); expect(await b.land()).toMatchObject({ status: 'landed' });
    await git(a.ws.path, 'rm', '-q', 'bad.txt'); await a.commit('shared.txt', 'A\n');
    const kept = await git(a.ws.path, 'rev-parse', 'HEAD');
    let joined = false;
    expect(await h.manager.land(h.ctx, { workspace: a.ws.id, taskId: 'a', submitted: () => { joined = true; } })).toMatchObject({ status: 'conflict' });
    expect(joined).toBe(false);
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(kept);
    // A submission without a work item waits for its answer, and its worktree follows the branch.
    const c = await h.member('c'); await c.commit('c.txt', 'c\n');
    expect(await c.land()).toMatchObject({ status: 'landed', commits: 1 });
    expect(await git(c.ws.path, 'rev-parse', 'HEAD')).toBe(await h.head());
  }, 60_000);

  it('is switched by the main agent while the workflow runs', async () => {
    const h = await fixture(); await h.configure();
    await h.member('a');
    const configure = (input: Record<string, unknown>) => h.manager.configure(h.ctx, input) as Promise<LandingChange>;
    expect((await configure({})).landing).toMatchObject({ async: false, overridden: [] });
    expect(await configure({ async: true })).toMatchObject({ changed: true, landing: { async: true, overridden: ['async'] } });
    expect(h.manager.landing(h.state.workflowId)).toMatchObject({ async: true });
    expect(await configure({ async: false })).toMatchObject({ changed: true, landing: { async: false } });
    expect(h.manager.landing(h.state.workflowId)?.async).toBeUndefined();
    await expect(configure({ async: 'yes' })).rejects.toThrow('true or false');
  }, 60_000);
});

describe('submit_work', () => {
  type Landed = { workspace: string; taskId: string; submitted?: (info: LandSubmitted) => void };
  function harness(land: (input: Landed, signal: AbortSignal) => Promise<unknown>, landing?: (input: Record<string, unknown>) => Promise<unknown>, path = ':memory:') {
    let now = 1_000_000;
    const root: WorkflowRoot = { scopeId: 'submit-test', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace', policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
    const requests: WorkflowWorkerRequest[] = [];
    const finishers: Array<(result: WorkflowWorkerResult) => void> = [];
    const kernel = new WorkflowKernel(path, { resolveRoot: async () => root, wakeMain: async () => {}, resolveWorkspace: async () => {},
      land: async (_state, input, signal) => land(input, signal), ...(landing ? { landing: async (_state: unknown, input: Record<string, unknown>) => landing(input) } : {}),
      execute: async request => { requests.push(request); request.onRun('run-' + request.attemptId); request.onSession('native');
        return new Promise<WorkflowWorkerResult>(resolve => { finishers.push(resolve); request.signal.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true }); }); } }, () => now);
    closes.push(() => kernel.close());
    const state = () => kernel.state(root.scopeId)!;
    const send = (request: WorkflowWorkerRequest, method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'worker', scopeId: root.scopeId,
      workflowId: state().workflowId, taskId: request.task.taskId, attemptId: request.attemptId }, method, { operationId: randomUUID(), ...args });
    return { kernel, state, requests, send, advance: (ms: number) => { now += ms; },
      enqueue: (key: string) => kernel.scriptWork(root.scopeId, state().workflowId, state().script!.runId, { kind: 'enqueue', key, title: key, input: {} }),
      /** Ends the member's turn. */
      finish: async (request: WorkflowWorkerRequest) => {
        finishers[requests.indexOf(request)]!({ status: 'completed', text: 'done' });
        await vi.waitFor(() => expect(['starting', 'running', 'cancelling']).not.toContain(state().tasks.find(task => task.taskId === request.task.taskId)!.status));
      },
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

  it('answers that the submission is queued when the landing outlasts the wait, and keeps the answer until the member has read it', async () => {
    const releases: Array<(report: unknown) => void> = [];
    const h = harness(() => new Promise(resolve => { releases.push(resolve); }));
    const request = await h.start('ws-1');
    const grant = await h.send(request, 'claim_work') as Grant;
    const submit = (operationId: string, waitSeconds = 0) => h.send(request, 'submit_work', { operationId, claimId: grant.claimId, generation: grant.generation, waitSeconds });
    expect(await submit('submit-1')).toMatchObject({ status: 'queued', operationId: 'submit-1', stage: 'preparing' });
    // The landing goes on without a caller; a repeat waits for it, and so does a call under another operationId.
    expect(await submit('submit-1')).toMatchObject({ status: 'queued', operationId: 'submit-1' });
    expect(await submit('submit-2')).toMatchObject({ status: 'queued', operationId: 'submit-1' });
    expect(releases).toHaveLength(1);
    // The claim stays leased though no call is open.
    h.advance(100_000); await h.kernel.tick();
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'claimed' });
    releases[0]!({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'abc', commits: 1 });
    await vi.waitFor(() => expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed', result: { headCommit: 'abc' } }));
    // It landed while nobody waited. The member that submits the item again has yet to read that, and is told so.
    expect(await submit('submit-3')).toMatchObject({ status: 'landed', item: { status: 'completed' }, operationId: 'submit-1' });
    const again = await submit('submit-1') as Record<string, unknown>;
    expect(again).toMatchObject({ status: 'landed', item: { status: 'completed' } });
    expect(again.operationId).toBeUndefined();
    expect(releases).toHaveLength(1);
    await expect(h.send(request, 'submit_work', { waitSeconds: 3601 })).rejects.toThrow();
  });

  it('keeps a failed landing\'s answer for a repeat and lands anew under a new operationId once it was read', async () => {
    const releases: Array<{ resolve(report: unknown): void; reject(error: unknown): void }> = [];
    const h = harness(() => new Promise((resolve, reject) => { releases.push({ resolve, reject }); }));
    const request = await h.start('ws-1');
    const submit = (operationId: string, waitSeconds = 0) => h.send(request, 'submit_work', { operationId, waitSeconds });
    expect(await submit('one')).toMatchObject({ status: 'queued' });
    releases[0]!.resolve({ status: 'check_failed', targetRef: 'refs/heads/x', targetCommit: 'abc', headCommit: 'def', commands: [{ argv: ['test'], code: 1, stdout: '', stderr: 'boom' }] });
    expect(await submit('one', 5)).toMatchObject({ status: 'check_failed', commands: [{ stderr: 'boom' }] });
    expect(await submit('one')).toMatchObject({ status: 'check_failed' });
    expect(releases).toHaveLength(1);
    // The repair goes in under a new operationId. What fails for a reason of the queue's is kept the same way.
    expect(await submit('two')).toMatchObject({ status: 'queued', operationId: 'two' });
    expect(releases).toHaveLength(2);
    releases[1]!.reject(new Error('The landing train failed 8 times in a row'));
    await expect(submit('two', 5)).rejects.toThrow('8 times in a row');
    await expect(submit('two')).rejects.toThrow('8 times in a row');
    // Without a claim an answer nobody read is not mistaken for that of new commits.
    expect(await submit('three')).toMatchObject({ status: 'queued', operationId: 'three' });
    releases[2]!.resolve({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'abc', commits: 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await submit('four')).toMatchObject({ status: 'queued', operationId: 'four' });
    expect(releases).toHaveLength(4);
  });

  describe('where members go on without the answer', () => {
    type Taken = Grant & { item: { key: string; landing?: { status: string } } };
    const joined = (targetCommit: string, headCommit: string): LandSubmitted => ({ targetRef: 'refs/heads/x', targetCommit, headCommit, commits: 1, worktree: 'reset' });
    /** A landing queue that takes every submission and answers when the test says so. */
    function queue(path?: string) {
      const lands: Landed[] = [], answers: Array<{ resolve(report: unknown): void; reject(error: unknown): void }> = [];
      const h = harness(input => { lands.push(input); return new Promise((resolve, reject) => { answers.push({ resolve, reject }); }); }, undefined, path);
      const item = (key = 'bug-1') => h.state().workQueue!.items.find(item => item.key === key)!;
      /** The member submits the item it holds; the queue takes it as the commits `targetCommit..headCommit`. */
      const handOff = async (request: WorkflowWorkerRequest, grant: Grant, operationId: string, targetCommit: string, headCommit: string) => {
        const pending = h.send(request, 'submit_work', { operationId, claimId: grant.claimId, generation: grant.generation, result: { fixed: operationId } });
        const at = lands.length;
        await vi.waitFor(() => expect(lands).toHaveLength(at + 1));
        lands[at]!.submitted!(joined(targetCommit, headCommit));
        return pending;
      };
      return { ...h, lands, answers, item, handOff };
    }

    it('hands the item to the landing queue, lets the member take the next one and completes the item when the commits land', async () => {
      const h = queue();
      const request = await h.start('ws-1'); await h.enqueue('bug-2');
      const grant = await h.send(request, 'claim_work') as Taken, claim = { claimId: grant.claimId, generation: grant.generation };
      expect(await h.handOff(request, grant, 'submit-1', 'aaa', 'bbb')).toEqual({ status: 'submitted', itemId: h.item().id, key: 'bug-1', targetCommit: 'aaa', headCommit: 'bbb', commits: 1, worktree: 'reset' });
      // The item is the queue's now: it is neither done nor anyone else's to take, and the member cannot end it.
      expect(h.item()).toMatchObject({ status: 'claimed' });
      expect(h.state().workQueue!.claims[0]).toMatchObject({ status: 'active', landing: { targetCommit: 'aaa', headCommit: 'bbb', commits: 1 } });
      await expect(h.send(request, 'complete_work', { ...claim, result: 1 })).rejects.toThrow('with the landing queue');
      await expect(h.send(request, 'submit_work', claim)).rejects.toThrow('with the landing queue');
      // A repeated call reads the answer and submits nothing.
      expect(await h.send(request, 'submit_work', { operationId: 'submit-1', ...claim, result: { fixed: 'submit-1' } })).toMatchObject({ status: 'submitted', key: 'bug-1', headCommit: 'bbb', worktree: 'reset' });
      expect(h.lands).toHaveLength(1);
      // The member takes its next item, and is shown what it has with the queue.
      const next = await h.send(request, 'claim_work') as Taken;
      expect(next.item.key).toBe('bug-2');
      expect(await h.send(request, 'read_context', { operationId: undefined })).toMatchObject({ workQueue: { claim: { itemId: h.item('bug-2').id }, submitted: ['bug-1'] } });
      await h.send(request, 'complete_work', { claimId: next.claimId, generation: next.generation, result: 2 });
      // Its turn ends, and time passes, while the commits wait: the item stays with the queue.
      await h.finish(request);
      h.advance(300_000); await h.kernel.tick();
      expect(h.item()).toMatchObject({ status: 'claimed' });
      h.answers[0]!.resolve({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'ccc', commits: 1 });
      await vi.waitFor(() => expect(h.item()).toMatchObject({ status: 'completed', result: { fixed: 'submit-1' }, doneBy: 'fixer' }));
      expect(h.state().workQueue!.claims[0]).toMatchObject({ status: 'completed' });
    });

    it('returns the item to its member with what the queue answered when the commits are turned back', async () => {
      const h = queue();
      const request = await h.start('ws-1'); await h.enqueue('bug-2');
      const grant = await h.send(request, 'claim_work') as Taken;
      await h.handOff(request, grant, 'submit-1', 'aaa', 'bbb');
      const next = await h.send(request, 'claim_work') as Taken;
      h.answers[0]!.resolve({ status: 'check_failed', targetRef: 'refs/heads/x', targetCommit: 'ccc', headCommit: 'ddd', reason: 'Checks changed the worktree HEAD',
        commands: [{ argv: ['test'], code: 1, stdout: '', stderr: 'x'.repeat(40_000) + 'boom' }] });
      await vi.waitFor(() => expect(h.item()).toMatchObject({ status: 'pending', assignee: 'fixer', landing: { status: 'check_failed', commits: 'aaa..bbb', reason: 'Checks changed the worktree HEAD' } }));
      const returned = h.item().landing as unknown as { report: { commands: Array<{ stderr: string }> } };
      expect(returned.report.commands[0]!.stderr.endsWith('boom')).toBe(true);
      expect(JSON.stringify(returned).length).toBeLessThan(17_000);
      // It is no attempt of the member's that failed, and the item did not come round with nothing done.
      expect(h.item().failures).toBeUndefined();
      expect(h.item().idleClaims).toBeUndefined();
      expect(JSON.stringify(h.state())).toContain('The landing queue turned back the commits you submitted for work item');
      // The member finishes what it is at and is handed the item again before other work, with the answer.
      await h.enqueue('bug-3');
      await h.send(request, 'complete_work', { claimId: next.claimId, generation: next.generation, result: 2 });
      const again = await h.send(request, 'claim_work') as Taken;
      expect(again.item).toMatchObject({ key: 'bug-1', landing: { status: 'check_failed' } });
      expect(again.generation).toBe(grant.generation + 1);
      // The repair is submitted like any item and lands.
      expect(await h.handOff(request, again, 'submit-2', 'ccc', 'eee')).toMatchObject({ status: 'submitted', headCommit: 'eee' });
      h.answers[1]!.resolve({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'fff', commits: 2 });
      await vi.waitFor(() => expect(h.item()).toMatchObject({ status: 'completed', result: { fixed: 'submit-2' } }));
      expect(h.item().landing).toBeUndefined();
    });

    it('returns a submission the queue gave up, and one whose queue stopped holding it', async () => {
      const h = queue();
      const request = await h.start('ws-1');
      const grant = await h.send(request, 'claim_work') as Taken;
      await h.handOff(request, grant, 'submit-1', 'aaa', 'bbb');
      h.answers[0]!.reject(new Error('The landing train failed 8 times in a row for a reason of its own'));
      await vi.waitFor(() => expect(h.item()).toMatchObject({ status: 'pending', assignee: 'fixer', landing: { status: 'failed', commits: 'aaa..bbb', reason: expect.stringContaining('8 times in a row') } }));
      const again = await h.send(request, 'claim_work') as Taken;
      await h.handOff(request, again, 'submit-2', 'aaa', 'bbb');
      // Nothing renews the lease in this test, as when the queue that had the submission is gone.
      h.advance(601_000); await h.kernel.tick();
      expect(h.item()).toMatchObject({ status: 'pending', landing: { status: 'lost', commits: 'aaa..bbb' } });
      // The turn of the member, which is at other work by now, is left alone.
      expect(h.state().tasks.find(task => task.taskId === request.task.taskId)!.status).toBe('running');
      // An answer that comes for an item the queue no longer holds changes nothing.
      h.answers[1]!.resolve({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'ccc', commits: 1 });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(h.item()).toMatchObject({ status: 'pending', landing: { status: 'lost' } });
    });

    it('returns what was with the queue when the bridge restarts', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'workflow-submitted-'));
      closes.push(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
      const h = queue();
      const request = await h.start('ws-1'); await h.enqueue('bug-2');
      const grant = await h.send(request, 'claim_work') as Taken;
      await h.handOff(request, grant, 'submit-1', 'aaa', 'bbb');
      const next = await h.send(request, 'claim_work') as Taken;
      const path = join(directory, 'snapshot.sqlite');
      replaceWorkflowState(path, h.state());
      const restored = queue(path);
      // The item the member was at stays its own for its next attempt; the one the queue had is turned back.
      expect(restored.item()).toMatchObject({ status: 'pending', assignee: 'fixer', landing: { status: 'lost', commits: 'aaa..bbb' } });
      expect(restored.state().workQueue!.claims.find(claim => claim.id === next.claimId)).toMatchObject({ status: 'active', heldUntil: expect.any(Number) });
    });
  });

  it('raises what the queue found out about the branch as an event for the main agent, once while it stands, and keeps it from the member', async () => {
    const halted = { status: 'halted', targetRef: 'refs/heads/x', targetCommit: 'abc', reason: 'moved' };
    const reports = [{ ...halted, notice: '落地已停止：x' }, { ...halted, notice: '落地已停止：x' }, { status: 'landed', targetRef: 'refs/heads/x', headCommit: 'def', commits: 1, notice: '落地分支 x 有 1 个提交未经 submit_work 进入' }];
    const h = harness(async () => reports.shift());
    const request = await h.start('ws-1');
    const grant = await h.send(request, 'claim_work') as Grant;
    const attention = () => h.state().events.filter(event => event.kind === 'landing_attention').map(event => event.summary);
    expect(await h.send(request, 'submit_work', { claimId: grant.claimId, generation: grant.generation })).toEqual(halted);
    expect(await h.send(request, 'submit_work', { claimId: grant.claimId, generation: grant.generation })).toEqual(halted);
    expect(attention()).toEqual(['落地已停止：x']);
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'claimed' });
    const landed = await h.send(request, 'submit_work', { claimId: grant.claimId, generation: grant.generation }) as Record<string, unknown>;
    expect(landed).toMatchObject({ status: 'landed', item: { status: 'completed' } });
    expect(landed.notice).toBeUndefined();
    expect(attention()).toEqual(['落地已停止：x', '落地分支 x 有 1 个提交未经 submit_work 进入']);
  });

  it('settles the notice that the branch is halted once the main agent has restored or adopted it', async () => {
    const halted = { status: 'halted', targetRef: 'refs/heads/x', targetCommit: 'abc', reason: 'moved' };
    let standing: string | undefined = 'moved';
    const h = harness(async () => ({ ...halted, notice: '落地已停止：x' }), async input => {
      if (input.branch) standing = undefined;
      return { changed: false, landing: { branches: [{ repository: '/repo', head: 'abc', waiting: 0, ...(standing ? { halted: standing } : {}) }] } };
    });
    const request = await h.start('ws-1');
    const grant = await h.send(request, 'claim_work') as Grant;
    const notice = () => h.state().events.find(event => event.kind === 'landing_attention')!;
    expect(await h.send(request, 'submit_work', { claimId: grant.claimId, generation: grant.generation })).toEqual(halted);
    expect(notice()).toMatchObject({ acknowledged: false, subject: 'landing:halted' });
    const main = (args: Record<string, unknown>) => h.kernel.call({ kind: 'main', scopeId: 'submit-test' }, 'configure_landing', args);
    // Looking at a landing that is still halted leaves the notice standing.
    await main({});
    expect(notice().acknowledged).toBe(false);
    await main({ branch: 'adopt' });
    expect(notice().acknowledged).toBe(true);
  });

  it('lets the main agent, and no worker, look at and change the landing', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = harness(async () => ({ status: 'landed' }), async input => { calls.push(input); return { changed: Object.keys(input).length > 0 }; });
    const request = await h.start('ws-1');
    const main = (args: Record<string, unknown>) => h.kernel.call({ kind: 'main', scopeId: 'submit-test' }, 'configure_landing', args);
    expect(await main({})).toEqual({ changed: false });
    expect(await main({ workflowId: h.state().workflowId, operationId: 'habit', expectedStateVersion: 1, batch: 2, checks: [{ argv: ['true'] }] })).toEqual({ changed: true });
    expect(calls).toEqual([{}, { batch: 2, checks: [{ argv: ['true'] }] }]);
    await expect(h.send(request, 'configure_landing', { batch: 1 })).rejects.toThrow();
    expect(calls).toHaveLength(2);
    const bare = harness(async () => ({ status: 'landed' }));
    await bare.start('ws-1');
    await expect(bare.kernel.call({ kind: 'main', scopeId: 'submit-test' }, 'configure_landing', {})).rejects.toThrow('Landing is unavailable');
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
  it.each(['worktree', 'clone'] as const)('runs the packaged example: members claim bugs, commit in their %ss and land them over IPC', async isolation => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-claim-land-'));
    closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
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
        expect(spec.systemPrompt).toContain('Submit each item as soon as its own check passes');
        expect(spec.systemPrompt).toContain(`Managed ${isolation}: ${cwd}`);
        // A clone sees the landing branch through its remote; a worktree shares the checkout's refs.
        const refs = isolation === 'clone' ? `refs/remotes/${CLONE_REMOTE}/bridge-workflow` : 'refs/heads/bridge-workflow';
        /** One turn of a fixer: claim until the queue is empty. */
        const work = (async () => {
          for (;;) {
            const grant = await callWorkflow('claim_work', { operationId: randomUUID() }, spec.env) as { claimId: string; generation: number; item: { key: string } } | null;
            if (!grant) return;
            const claim = { claimId: grant.claimId, generation: grant.generation };
            if (isolation === 'clone') await git(cwd, 'fetch', '--quiet', CLONE_REMOTE);
            const branch = (await git(cwd, 'for-each-ref', '--format=%(refname)', refs)).split('\n')[0];
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
      args: { members: 4, isolation, items: keys.map(key => ({ key, title: key })), checks: [{ argv: [process.execPath, '-e', `if(!require('fs').existsSync('fixed.txt'))process.exit(1)`] }] } }, main.env);
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

  it.each(['worktree', 'clone'] as const)('lets members hand a fix to the queue and take the next bug, and returns a fix that fails the checks to its member (%s)', async isolation => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-claim-async-'));
    closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const repo = join(dir, 'repo'); await mkdir(repo);
    await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
    await writeFile(join(repo, 'README'), 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'main', modelSettings: {} };
    const answers: string[] = [], returned: Array<{ key: string; status: string }> = [];
    const runtime = new WorkflowRuntime({ path: join(dir, 'workflows.sqlite'), resolveRoot: async () => root, wakeMain: async () => {}, authorizeWorkspace: async () => {},
      runner: { async start(spec) {
        await spec.validateBeforeRun();
        const cwd = spec.workspace!.path;
        const commit = (message: string) => git(cwd, '-c', 'user.name=Fixer', '-c', 'user.email=fixer@localhost', 'commit', '-q', '-m', message);
        /** One turn of a fixer: claim, fix, hand the fix to the queue and claim again, until there is nothing to claim. */
        const work = (async () => {
          for (;;) {
            const grant = await callWorkflow('claim_work', { operationId: randomUUID() }, spec.env) as { claimId: string; generation: number; item: { key: string; landing?: { status: string; commits: string } } } | null;
            if (!grant) return;
            const { key, landing } = grant.item;
            if (landing) {
              // The queue turned this fix back: bring the commits back and repair them.
              returned.push({ key, status: landing.status });
              await git(cwd, '-c', 'user.name=Fixer', '-c', 'user.email=fixer@localhost', 'cherry-pick', landing.commits);
              await git(cwd, 'rm', '-q', 'broken.txt'); await commit(`${key}: repair`);
            } else {
              await writeFile(join(cwd, `fix-${key}.txt`), key + '\n');
              if (key === 'bug-3') await writeFile(join(cwd, 'broken.txt'), 'x\n');
              await git(cwd, 'add', '.'); await commit(key);
            }
            const report = await callWorkflow('submit_work', { operationId: randomUUID(), claimId: grant.claimId, generation: grant.generation, result: { fixed: key } }, spec.env) as { status: string; targetCommit: string };
            answers.push(report.status);
            if (report.status !== 'submitted') throw new Error(`submit_work answered ${report.status}`);
            // The worktree is at the tip of the branch, without the fix that waits in the queue.
            expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(report.targetCommit);
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
    const keys = Array.from({ length: 9 }, (_, index) => `bug-${index}`);
    await callWorkflow('run_script', { operationId: randomUUID(), goal: 'Fix bugs', plan: 'Three fixers claim nine bugs, hand each fix to the landing queue and go on.', maxConcurrent: 3, maxAgents: 64,
      script: await readFile(new URL('../../../workflow-definitions/scripted/examples/claim-and-land.js', import.meta.url), 'utf8'),
      args: { members: 3, isolation, async: true, items: keys.map(key => ({ key, title: key })),
        checks: [{ argv: [process.execPath, '-e', `const fs=require('fs');if(fs.existsSync('broken.txt')){console.error('broken.txt present');process.exit(1)}`] }] } }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script?.status).not.toBe('running'); }, { timeout: 100_000, interval: 100 });
    const state = runtime.kernel.state(root.scopeId)!;
    expect(state.script).toMatchObject({ status: 'result_ready' });
    const result = JSON.parse(state.artifacts.find(artifact => artifact.ref === state.script?.resultRef)!.text!) as { branch: string; queues: Record<string, unknown> };
    expect(result.queues).toMatchObject({ default: { completed: 9 } });
    expect(state.workQueue!.items.map(item => item.result)).toEqual(expect.arrayContaining(keys.map(key => ({ fixed: key }))));
    // Nobody waited for a train: every call was answered as soon as its fix was in the queue, the broken one included.
    expect(answers).toEqual(Array(10).fill('submitted'));
    expect(returned).toEqual([{ key: 'bug-3', status: 'check_failed' }]);
    const files = (await git(repo, 'ls-tree', '--name-only', result.branch)).split('\n');
    expect(files).toEqual(expect.arrayContaining(keys.map(key => `fix-${key}.txt`)));
    expect(files).not.toContain('broken.txt');
    expect(await git(repo, 'rev-list', '--min-parents=2', result.branch)).toBe('');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'main'));
  }, 120_000);
});
