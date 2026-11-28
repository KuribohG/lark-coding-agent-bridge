import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { callWorkflow, WorkflowRuntime } from '../src';
import { LandingRecords } from '../src/dashboard/landing';
import { landing as landingPanel } from '../src/dashboard/views';
import { WorkflowKernel } from '../src/engine/kernel';
import { replaceWorkflowState } from '../src/engine/kernel-store';
import { submittedCommits } from '../src/engine/work-queue';
import { nodeProcesses, workspaceCommand } from '../src/engine/workspace-process';
import type { WorkflowProcesses } from '../src/engine/ports';
import { CLONE_REMOTE, WorkflowWorkspaces, type TrainTiming, type WorkspacePlaces } from '../src/engine/workspaces';
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
/** The change a member's `commit` makes, in a commit of its own: two members that wrote the same fix. */
const twinCommit = async (ws: WorkspaceBinding, file: string, content: string) => {
  await writeFile(join(ws.path, file), content); await git(ws.path, 'add', '.'); await git(ws.path, 'commit', '-q', '-m', `${file}, by another`);
};

async function fixture(timing: Partial<TrainTiming> = {}, processes?: WorkflowProcesses, places: WorkspacePlaces = {}) {
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
  const manager = new WorkflowWorkspaces(join(dir, 'workspaces.sqlite'), join(dir, 'worktrees'), processes, timing, places);
  closes.push(() => manager.close());
  const ctx = { state, signal: signal() };
  const op = <T>(kind: string, key: string, args: object = {}) => manager.perform(ctx, { kind, key, ...args }) as Promise<T>;
  /** A member's worktree with a turn running in it. */
  const member = async (name: string) => {
    const ws = await op<WorkspaceBinding>('create', name);
    manager.begin(ws, name);
    let last: LandSubmitted | undefined;
    return { ws,
      /** Submits the commits and waits for what the queue makes of them, which a member does not do. `front` puts them at the head of the queue. */
      land: (front?: string) => manager.land(ctx, { workspace: ws.id, taskId: name, submitted: info => { last = info; return { key: 'item-' + name, member: name }; }, ...(front === undefined ? {} : { front }) }),
      /** The commits it last submitted, as the queue took them. */
      submitted: () => last!,
      /** Brings the commits it last submitted back into the worktree, as a member does with an item that came back to it. */
      restore: () => git(ws.path, 'cherry-pick', `${last!.targetCommit}..${last!.headCommit}`),
      /** Moves the worktree to the landing branch as it is now. */
      update: async () => git(ws.path, 'reset', '--hard', '--quiet', await head()),
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
  /** The latest trains of the landing ledger, newest first, and the branch as the main agent sees it. */
  const trains = async (count = 10) => ((await manager.configure(ctx, { trains: count })) as LandingChange).trains!;
  const branch = async () => ((await manager.configure(ctx, {})) as LandingChange).landing.branches[0]!;
  return { dir, repo, base, state, manager, ctx, op, member, configure, head, logged, runs, together, waiting, gate, log, trains, branch };
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
    // The worktree went back to the branch when the commits joined the queue: the member brings them back to repair them.
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    await a.restore();
    await git(a.ws.path, 'rm', '-q', 'bad.txt'); await a.commit('good.txt', 'y\n');
    await h.configure([node(`require('fs').writeFileSync('left-behind', '')`)]);
    expect(await a.land()).toMatchObject({ status: 'check_failed', reason: expect.stringContaining('untracked') });
    await h.configure();
    await a.restore();
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
    // Every worktree was left where the branch was when its commits joined the queue, clean, for the member's next fix.
    for (const member of members) {
      expect(await git(member.ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
      expect(await git(member.ws.path, 'status', '--porcelain')).toBe('');
    }
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
    // The branch only ever pointed at commits the checks passed on, and the loser is told the commits that failed and what they were on.
    const loser = members[reports.indexOf(failed[0]!)]!;
    expect(await git(h.repo, 'rev-parse', `${failed[0]!.headCommit}~1`)).toBe(failed[0]!.targetCommit);
    expect((await git(h.repo, 'ls-tree', '--name-only', failed[0]!.headCommit)).split('\n')).toEqual(expect.arrayContaining(['mine.txt', 'theirs.txt']));
    // Its worktree, which it may be at other work in by now, was not touched.
    expect(await git(loser.ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
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

  it('keeps the train where the host says, and makes it again when that directory is gone', async () => {
    let trains = '';
    const h = await fixture({}, undefined, { trainRoot: () => trains });
    trains = join(h.dir, 'trains');
    await h.configure([h.logged()]);
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1 });
    const own = join(trains, h.state.workflowId), found = await readdir(own);
    expect(found).toEqual([expect.stringMatching(/^train-[a-f0-9]{16}$/)]);
    const train = join(own, found[0]!);
    // Every check ran there, and nothing of the train is beside the members' worktrees.
    expect([...new Set(await h.runs())]).toEqual([await realpath(train)]);
    expect((await readdir(join(h.dir, 'worktrees', h.state.workflowId))).filter(name => name.startsWith('train-'))).toEqual([]);
    // The directory is gone, as after the machine was replaced, and the repository still has the locked record of it.
    await rm(trains, { recursive: true });
    await a.update(); await a.commit('b.txt', 'b\n');
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1 });
    expect(await git(train, 'rev-parse', 'HEAD')).toBe(await h.head());
    expect((await git(h.repo, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ') && line.includes('/train-'))).toHaveLength(1);
    // It goes with the last member worktree, and with it the directory the workflow had there.
    h.manager.end(a.ws, (await h.manager.binding(h.state.root, h.state.workflowId, a.ws.id, signal())).busy!.token);
    expect(await h.op('cleanup', 'clean', { workspace: a.ws.id })).toMatchObject({ removed: true });
    expect(await git(h.repo, 'worktree', 'list', '--porcelain')).not.toContain('/train-');
    expect(await access(own).then(() => true, () => false)).toBe(false);
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

  it('lands while a member\'s worktree is on the branch, and takes the branch from that worktree where it stands', async () => {
    const h = await fixture(); const { landing, landed } = await configured(h);
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    // A member switches to the branch to look at it, and goes on working there.
    await git(a.ws.path, 'checkout', '-q', landing.targetRef.replace('refs/heads/', ''));
    await writeFile(join(a.ws.path, 'shared.txt'), 'edited\n'); await git(a.ws.path, 'add', 'shared.txt'); await writeFile(join(a.ws.path, 'draft.txt'), 'draft\n');
    const status = await git(a.ws.path, 'status', '--porcelain');
    await b.commit('b.txt', 'b\n');
    expect(await b.land()).toMatchObject({ status: 'landed', commits: 1 });
    expect(await git(h.repo, 'rev-parse', `${landing.targetRef}~1`)).toBe(landed);
    // The worktree is on the commit it was on, off the branch, and its index and files are as the member left them:
    // on the branch they would read as a change that takes b.txt out again.
    await expect(git(a.ws.path, 'symbolic-ref', '--quiet', 'HEAD')).rejects.toThrow();
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(landed);
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe(status);
    expect(await git(a.ws.path, 'reflog', 'show', '--format=%gs', '-1')).toContain('taken off the landing branch');
    // What it commits from here is its own, and reaches the branch through the queue.
    await a.commit('a.txt', 'a\n');
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1 });
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'draft.txt']));
    expect(await git(h.repo, 'show', `${landing.targetRef}:shared.txt`)).toBe('edited');
    expect((await git(h.repo, 'reflog', 'show', '--format=%gs', landing.targetRef)).split('\n').every(line => line.startsWith('bridge-workflow: landed'))).toBe(true);
  }, 60_000);

  it('restores a branch that the worktree that moved it is still on, and leaves that worktree on its commit', async () => {
    const h = await fixture(); const { landing, landed } = await configured(h);
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    await git(a.ws.path, 'checkout', '-q', landing.targetRef.replace('refs/heads/', ''));
    await a.commit('bad.txt', 'x\n');
    const bad = await git(a.ws.path, 'rev-parse', 'HEAD');
    expect(await git(h.repo, 'rev-parse', landing.targetRef)).toBe(bad);
    await b.commit('b.txt', 'b\n');
    expect(await b.land()).toMatchObject({ status: 'halted', targetCommit: bad });
    expect((await h.manager.configure(h.ctx, { branch: 'restore' })).settled).toMatchObject([{ branch: 'restored', head: landed }]);
    expect(await git(h.repo, 'rev-parse', landing.targetRef)).toBe(landed);
    await expect(git(a.ws.path, 'symbolic-ref', '--quiet', 'HEAD')).rejects.toThrow();
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(bad);
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('');
    expect(await b.land()).toMatchObject({ status: 'landed', commits: 1 });
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

  it('keeps the submissions that wait when the branch moves under a train, and lands them once the branch is settled', async () => {
    // A poll this slow never comes: settling the branch is what sets the train going again.
    const h = await fixture({ haltPollMs: 600_000 });
    const gate = join(h.dir, 'gate'); await writeFile(gate, '');
    const landing = await h.configure([h.logged('', true), noBadFile]);
    const first = await h.member('first'); await first.commit('first.txt', 'x\n');
    expect(await first.land()).toMatchObject({ status: 'landed' });
    const landed = await git(h.repo, 'rev-parse', landing.targetRef);
    await rm(gate, { force: true });
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    await a.commit('a.txt', 'a\n'); await b.commit('b.txt', 'b\n');
    const notices: string[] = [];
    const submit = (member: typeof a, name: string) => h.manager.land(h.ctx, { workspace: member.ws.id, taskId: name, noticed: (notice, halted) => { expect(halted).toBe(true); notices.push(notice); } });
    const before = (await h.runs()).length, held = submit(a, 'a');
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(before + 1), { timeout: 20_000, interval: 20 });
    const waiting = submit(b, 'b'), trains = (h.manager as unknown as { trains: Map<string, { queue: unknown[] }> }).trains;
    await vi.waitFor(() => expect([...trains.values()][0]!.queue).toHaveLength(1), { timeout: 20_000, interval: 20 });
    const bad = await outside(h, landing.targetRef, 'bad.txt');
    await writeFile(gate, '');
    // The train that was checking runs again and looks at the branch first. Nothing lands, nobody is sent back, and
    // the main agent hears of it once, through a submission that waits.
    await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 20_000, interval: 20 });
    expect(notices[0]).toContain('落地已停止');
    expect(notices[0]).toContain('已在队列里的提交留在队列里等待');
    expect([...trains.values()][0]!.queue).toHaveLength(2);
    expect(((await h.manager.configure(h.ctx, {})) as LandingChange).landing.branches[0]).toMatchObject({ head: bad, landed, waiting: 2, halted: expect.stringContaining('fail the landing checks') });
    // A submission that comes now is answered at once, and keeps its commits.
    const c = await h.member('c'); await c.commit('c.txt', 'c\n');
    const kept = await git(c.ws.path, 'rev-parse', 'HEAD');
    expect(await c.land()).toMatchObject({ status: 'halted', targetCommit: bad });
    expect(await git(c.ws.path, 'rev-parse', 'HEAD')).toBe(kept);
    // The main agent settles the branch, and the ones that waited land in their order.
    expect(await h.manager.configure(h.ctx, { branch: 'restore' })).toMatchObject({ settled: [{ branch: 'restored', head: landed }] });
    expect(await held).toMatchObject({ status: 'landed', commits: 1 });
    expect(await waiting).toMatchObject({ status: 'landed', commits: 1 });
    expect(notices).toHaveLength(1);
    const files = (await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n');
    expect(files).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    expect(files).not.toContain('bad.txt');
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
    for (const member of [a, b]) expect(await git(member.ws.path, 'status', '--porcelain')).toBe('');
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

  /** Holds a train at its checks while the members submit one after the other, so that the next train stacks them in that order. */
  const inOrder = async (h: Awaited<ReturnType<typeof fixture>>, members: Array<{ land(): Promise<LandReport> }>) => {
    const blocker = await h.member('blocker'); await blocker.commit('blocker.txt', 'x\n');
    const first = blocker.land();
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(1), { timeout: 20_000, interval: 20 });
    const reports: Promise<LandReport>[] = [];
    for (const [index, member] of members.entries()) {
      reports.push(member.land());
      await vi.waitFor(() => expect(h.waiting()).toBe(index + 1), { timeout: 20_000, interval: 20 });
    }
    await writeFile(h.gate, '');
    expect(await first).toMatchObject({ status: 'landed' });
    return Promise.all(reports);
  };
  const unlessBad = `if(fs.existsSync('bad.txt')){console.error('bad');process.exit(1)}`;

  it('gives a submission that adds no commit to the stack no place in the search, and lands it with what holds its commits', async () => {
    const h = await fixture(); const landing = await h.configure([h.logged(unlessBad, true)]);
    const a = await h.member('a'), twin = await h.member('twin'), bad = await h.member('bad');
    await a.commit('same.txt', 'the same change\n'); await twinCommit(twin.ws, 'same.txt', 'the same change\n'); await bad.commit('bad.txt', 'x\n');
    const reports = await inOrder(h, [a, twin, bad]);
    expect(reports).toMatchObject([{ status: 'landed', commits: 1 }, { status: 'landed', commits: 0, headCommit: await h.head() }, { status: 'check_failed' }]);
    // The blocker's run, and two for the train of three: the two that added commits, then the first of them. The stack
    // is the same commit with the twin and without, and no run was spent to tell the two apart.
    expect(await h.runs()).toHaveLength(3);
    const [train] = await h.trains(1);
    expect(train).toMatchObject({ outcome: 'done', checks: [{ submissions: 2, passed: false }, { submissions: 1, passed: true }],
      submissions: [{ member: 'a', outcome: 'landed' }, { member: 'twin', outcome: 'landed' }, { member: 'bad', outcome: 'check_failed' }] });
    expect(new Set(train!.checks.map(probe => probe.headCommit)).size).toBe(2);
    expect((await git(h.repo, 'log', '--format=%s', `${h.base}..${landing.targetRef}`)).split('\n')).toEqual(['same.txt', 'blocker.txt']);
    expect((await h.branch()).recent![0]).toMatchObject({ submissions: 3, landed: 2, turnedBack: [{ member: 'bad', status: 'check_failed' }] });
  }, 60_000);

  it('has it ride the next train when what holds its commits fails the checks, where it is checked on its own', async () => {
    const h = await fixture(); const landing = await h.configure([h.logged(unlessBad, true)]);
    const bad = await h.member('bad'), twin = await h.member('twin'), c = await h.member('c');
    await bad.commit('bad.txt', 'x\n'); await twinCommit(twin.ws, 'bad.txt', 'x\n'); await c.commit('c.txt', 'c\n');
    const reports = await inOrder(h, [bad, twin, c]);
    expect(reports.map(report => report.status)).toEqual(['check_failed', 'check_failed', 'landed']);
    // The twin was answered for commits of its own, on the branch as it was.
    const failed = reports[1] as Extract<LandReport, { status: 'check_failed' }>;
    expect(await git(h.repo, 'rev-parse', `${failed.headCommit}~1`)).toBe(failed.targetCommit);
    expect(await git(h.repo, 'log', '-1', '--format=%s', failed.headCommit)).toBe('bad.txt, by another');
    const [third, second, first] = await h.trains(3);
    expect(first).toMatchObject({ checks: [{ submissions: 2, passed: false }, { submissions: 1, passed: false }],
      submissions: [{ member: 'bad', outcome: 'check_failed' }, { member: 'twin', outcome: 'next' }, { member: 'c', outcome: 'next' }] });
    expect(second).toMatchObject({ checks: [{ submissions: 2, passed: false }, { submissions: 1, passed: false }],
      submissions: [{ member: 'twin', outcome: 'check_failed' }, { member: 'c', outcome: 'next' }] });
    expect(third).toMatchObject({ checks: [{ submissions: 1, passed: true }], submissions: [{ member: 'c', outcome: 'landed' }] });
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n').sort()).toEqual(['blocker.txt', 'c.txt', 'shared.txt']);
  }, 60_000);

  it('answers a submission whose commits the branch got while it waited as landed, without a run of the checks', async () => {
    const h = await fixture(); const landing = await h.configure([h.logged('', true)], { batch: 1 });
    const a = await h.member('a'), twin = await h.member('twin');
    await a.commit('same.txt', 'the same change\n'); await twinCommit(twin.ws, 'same.txt', 'the same change\n');
    const reports = await inOrder(h, [a, twin]);
    expect(reports).toMatchObject([{ status: 'landed', commits: 1 }, { status: 'landed', commits: 0, headCommit: await h.head() }]);
    // A train takes one submission here: the blocker's ran the checks, and a's. The twin's had nothing to run them on.
    expect(await h.runs()).toHaveLength(2);
    const [last, before] = await h.trains(2);
    expect(last).toMatchObject({ outcome: 'done', checks: [], submissions: [{ member: 'twin', outcome: 'landed' }] });
    expect(last!.head).toBeUndefined();
    expect(before).toMatchObject({ head: await h.head(), submissions: [{ member: 'a', outcome: 'landed' }] });
    expect(await git(h.repo, 'rev-list', '--count', `${h.base}..${landing.targetRef}`)).toBe('2');
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
    await b.restore();
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
    await a.restore();
    const report = await a.land();
    expect(report).toMatchObject({ status: 'landed', commits: 1 });
    expect(report.notice).toContain('把这一批提交退回给了成员');
  }, 60_000);

  it('shows the main agent the train that runs, what waits behind it and a train that runs again', async () => {
    const h = await fixture({ retryDelaysMs: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20] });
    const gate = join(h.dir, 'gate'); await writeFile(gate, '');
    await h.configure([h.logged('', true)]);
    const first = await h.member('first'); await first.commit('first.txt', 'x\n');
    expect(await first.land()).toMatchObject({ status: 'landed' });
    const own = await git((await h.runs())[0]!, 'rev-parse', '--absolute-git-dir');
    const a = await h.member('a'), b = await h.member('b'), c = await h.member('c');
    await a.commit('a.txt', 'a\n'); await b.commit('b.txt', 'b\n'); await c.commit('c.txt', 'c\n');
    const branch = async () => ((await h.manager.configure(h.ctx, {})) as LandingChange).landing.branches[0]!;
    expect(await branch()).toMatchObject({ waiting: 0 });
    expect((await branch()).train).toBeUndefined();
    // The view waits for the worktree of the train, so it is taken between two runs: read the queue itself while one runs.
    const trains = (h.manager as unknown as { trains: Map<string, { queue: unknown[]; current?: { batch: unknown[]; step: string; checks: number }; trouble?: { failures: number; reason: string } }> }).trains;
    const train = () => [...trains.values()][0];
    await rm(gate);
    const landA = a.land();
    await vi.waitFor(() => expect(train()?.current).toMatchObject({ step: 'checking', checks: 1 }), { timeout: 20_000, interval: 10 });
    const landB = b.land(), landC = c.land();
    await vi.waitFor(() => expect(train()!.queue).toHaveLength(2), { timeout: 20_000, interval: 10 });
    expect(train()!.current!.batch).toHaveLength(1);
    // A train that runs again for a reason of its own says so.
    await writeFile(join(own, 'index.lock'), ''); await writeFile(gate, '');
    expect(await landA).toMatchObject({ status: 'landed' });
    await vi.waitFor(() => expect(train()?.trouble?.failures).toBeGreaterThanOrEqual(1), { timeout: 20_000, interval: 10 });
    expect(await branch()).toMatchObject({ waiting: 2, retrying: { reason: expect.stringContaining('index.lock') } });
    await rm(join(own, 'index.lock'));
    expect((await Promise.all([landB, landC])).map(report => report.status)).toEqual(['landed', 'landed']);
    expect(await branch()).toMatchObject({ waiting: 0 });
  }, 60_000);

  it('does not run a check again that ran out of time', async () => {
    const h = await fixture({ retryDelaysMs: [10, 10] });
    await h.configure([{ ...h.logged('setTimeout(()=>{},60000)'), timeoutMs: 300 }]);
    const a = await h.member('a'); await a.commit('a.txt', 'a\n');
    await expect(a.land()).rejects.toThrow('timed out');
    expect(await h.runs()).toHaveLength(1);
  }, 60_000);
});

describe('taking a submission out of the queue', () => {
  /**
   * A check that holds a train while `block.txt` is on it and the gate is shut, and one that holds `slow.txt` until a
   * second gate opens: the first lets submissions gather behind a train, the second keeps the train they share at its check.
   */
  const held = (h: Awaited<ReturnType<typeof fixture>>) => {
    const second = join(h.dir, 'gate-2');
    const check = node(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(h.log)},process.cwd()+'\\n');`
      + `const wait=f=>{const t=setInterval(()=>{if(fs.existsSync(f))clearInterval(t)},10)};`
      + `if(fs.existsSync('slow.txt'))wait(${JSON.stringify(second)});else if(fs.existsSync('block.txt'))wait(${JSON.stringify(h.gate)})`);
    return { check, second };
  };
  /** Holds a train at its check and has `submit` put its submissions in the queue behind it. */
  const behind = async <T>(h: Awaited<ReturnType<typeof fixture>>, count: number, submit: () => T) => {
    const blocker = await h.member('blocker'); await blocker.commit('block.txt', 'x\n');
    const first = blocker.land();
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(1), { timeout: 20_000, interval: 20 });
    const rest = submit();
    await vi.waitFor(() => expect(h.waiting()).toBe(count), { timeout: 20_000, interval: 20 });
    return { first, rest };
  };

  it('answers a submission that waits as withdrawn, and lands the others without it', async () => {
    const h = await fixture();
    const landing = await h.configure([held(h).check]);
    const a = await h.member('a'), b = await h.member('b');
    await a.commit('a.txt', 'a\n'); await b.commit('b.txt', 'b\n');
    const { first, rest } = await behind(h, 2, () => [a.land(), b.land()]);
    const workflow = h.state.workflowId, commits = b.submitted();
    expect(h.manager.withdraw(workflow, commits.headCommit, 'Withdrawn by lead: breaks the build')).toBe('withdrawn');
    expect(await rest[1]).toEqual({ status: 'withdrawn', targetRef: landing.targetRef, targetCommit: h.base, headCommit: commits.headCommit, reason: 'Withdrawn by lead: breaks the build' });
    expect(h.waiting()).toBe(1);
    // The queue does not hold it any more, nor commits it never had, nor those of another workflow.
    expect(h.manager.withdraw(workflow, commits.headCommit, 'again')).toBe('absent');
    expect(h.manager.withdraw(workflow, h.base, 'never submitted')).toBe('absent');
    expect(h.manager.withdraw('other-workflow', a.submitted().headCommit, 'not ours')).toBe('absent');
    await writeFile(h.gate, '');
    expect(await first).toMatchObject({ status: 'landed' });
    expect(await rest[0]).toMatchObject({ status: 'landed' });
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n').sort()).toEqual(['a.txt', 'block.txt', 'shared.txt']);
    // Its commits are still there for the member to bring back, and what landed cannot be withdrawn.
    expect(await git(h.repo, 'cat-file', '-t', commits.headCommit)).toBe('commit');
    expect(h.manager.withdraw(workflow, a.submitted().headCommit, 'landed')).toBe('absent');
  }, 60_000);

  it('stops the check of the train that carries a withdrawn submission, and runs the train again at once without it', async () => {
    const h = await fixture();
    const { check, second } = held(h);
    const landing = await h.configure([check]);
    const a = await h.member('a'), slow = await h.member('slow'), c = await h.member('c');
    await a.commit('a.txt', 'a\n'); await slow.commit('slow.txt', 's\n'); await c.commit('c.txt', 'c\n');
    const { first, rest } = await behind(h, 3, () => [a.land(), slow.land(), c.land()]);
    await writeFile(h.gate, '');
    expect(await first).toMatchObject({ status: 'landed' });
    // The three share a train, whose check does not end while slow.txt is on it.
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(2), { timeout: 20_000, interval: 20 });
    expect(h.manager.withdraw(h.state.workflowId, slow.submitted().headCommit, 'Withdrawn by lead: its test never ends')).toBe('withdrawn');
    expect(await rest[1]).toMatchObject({ status: 'withdrawn', reason: 'Withdrawn by lead: its test never ends' });
    // Nobody opened the second gate: the check was stopped, and the others landed on a stack without the withdrawn commits.
    expect((await Promise.all([rest[0]!, rest[2]!])).map(report => report.status)).toEqual(['landed', 'landed']);
    await expect(readFile(second, 'utf8')).rejects.toThrow();
    expect(await h.runs()).toHaveLength(3);
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n').sort()).toEqual(['a.txt', 'block.txt', 'c.txt', 'shared.txt']);
    expect(await git(h.repo, 'rev-list', '--count', `${h.base}..${landing.targetRef}`)).toBe('3');
    // The ledger tells it: the train that was stopped, with the check that did not finish, and the one that ran again.
    const [again, stopped] = await h.trains();
    // The order in which the three joined the queue is not fixed: the ledger keeps the order the train stacked them in.
    const byKey = (train: typeof stopped) => [...train!.submissions].sort((one, other) => one.key! < other.key! ? -1 : 1);
    expect(stopped).toMatchObject({ outcome: 'restacked', base: expect.any(String), checks: [{ submissions: 3, passed: false, reason: expect.stringContaining('aborted') }] });
    expect(byKey(stopped)).toMatchObject([{ key: 'item-a', member: 'a', outcome: 'next' }, { key: 'item-c', member: 'c', outcome: 'next' },
      { key: 'item-slow', member: 'slow', outcome: 'withdrawn', headCommit: slow.submitted().headCommit, commits: 1 }]);
    expect(again).toMatchObject({ outcome: 'done', head: await h.head(), checks: [{ submissions: 2, passed: true }] });
    expect(byKey(again)).toMatchObject([{ key: 'item-a', outcome: 'landed' }, { key: 'item-c', outcome: 'landed' }]);
  }, 60_000);

  it('does not stop the check for a withdrawn submission that added no commit to the stack', async () => {
    const h = await fixture();
    const { check, second } = held(h);
    await h.configure([check]);
    const slow = await h.member('slow'), twin = await h.member('twin');
    await slow.commit('slow.txt', 's\n'); await twinCommit(twin.ws, 'slow.txt', 's\n');
    const { first, rest } = await behind(h, 1, () => [slow.land()]);
    const other = twin.land();
    await vi.waitFor(() => expect(h.waiting()).toBe(2), { timeout: 20_000, interval: 20 });
    await writeFile(h.gate, '');
    expect(await first).toMatchObject({ status: 'landed' });
    // The two share a train. Its stack is the commit of the first, which holds all the twin brought.
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(2), { timeout: 20_000, interval: 20 });
    expect(h.manager.withdraw(h.state.workflowId, twin.submitted().headCommit, 'Withdrawn by twin: someone else has it')).toBe('withdrawn');
    expect(await other).toMatchObject({ status: 'withdrawn' });
    await writeFile(second, '');
    expect(await rest[0]).toMatchObject({ status: 'landed', commits: 1 });
    // The check that ran went on to its end, and no train ran again.
    expect(await h.runs()).toHaveLength(2);
    const [train] = await h.trains(1);
    expect(train).toMatchObject({ outcome: 'done', checks: [{ submissions: 1, passed: true }],
      submissions: [{ member: 'slow', outcome: 'landed' }, { member: 'twin', outcome: 'withdrawn' }] });
  }, 60_000);

  it('leaves a submission out that was withdrawn before its train stacked it, without stopping the train', async () => {
    const h = await fixture();
    const landing = await h.configure([held(h).check]);
    const a = await h.member('a'), b = await h.member('b');
    await a.commit('a.txt', 'a\n'); await b.commit('b.txt', 'b\n');
    const { first, rest } = await behind(h, 2, () => [a.land(), b.land()]);
    // The train takes both from the queue once the worktree is free, and looks at the branch before it stacks them.
    const trains = (h.manager as unknown as { trains: Map<string, { current?: { batch: unknown[]; stack: unknown[]; step: string } }> }).trains;
    await writeFile(h.gate, '');
    expect(await first).toMatchObject({ status: 'landed' });
    await vi.waitFor(() => expect([...trains.values()][0]?.current?.batch).toHaveLength(2), { timeout: 20_000, interval: 1 });
    const riding = [...trains.values()][0]!.current!;
    if (!riding.stack.length) {
      expect(h.manager.withdraw(h.state.workflowId, b.submitted().headCommit, 'Withdrawn by b: wrong fix')).toBe('withdrawn');
      expect(await rest[1]).toMatchObject({ status: 'withdrawn' });
      expect(await rest[0]).toMatchObject({ status: 'landed' });
      // The order in which the two joined the queue is not fixed.
      const train = (await h.trains(1))[0]!;
      expect(train).toMatchObject({ outcome: 'done', checks: [{ submissions: 1, passed: true }] });
      expect([...train.submissions].sort((x, y) => (x.key ?? '').localeCompare(y.key ?? ''))).toMatchObject([{ key: 'item-a', outcome: 'landed' }, { key: 'item-b', outcome: 'withdrawn' }]);
    } else expect((await Promise.all(rest)).map(report => report.status)).toEqual(['landed', 'landed']);
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n')).toContain('a.txt');
  }, 60_000);
});

describe('putting a submission at the head of the queue', () => {
  /** A check that holds a train while `block.txt` is on it and the gate is shut, and one that carries `slow.txt` until a second gate opens. */
  const held = (h: Awaited<ReturnType<typeof fixture>>) => {
    const second = join(h.dir, 'gate-2');
    const check = node(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(h.log)},process.cwd()+'\\n');`
      + `const wait=f=>{const t=setInterval(()=>{if(fs.existsSync(f))clearInterval(t)},10)};`
      + `if(fs.existsSync('slow.txt'))wait(${JSON.stringify(second)});else if(fs.existsSync('block.txt'))wait(${JSON.stringify(h.gate)})`);
    return { check, second };
  };
  /** The submissions that wait, in the order they board. */
  const queued = (h: Awaited<ReturnType<typeof fixture>>) => [...(h.manager as unknown as { trains: Map<string, { queue: Array<{ label?: { key?: string } }> }> }).trains.values()]
    .flatMap(train => train.queue.map(candidate => candidate.label?.key));
  const subjects = (h: Awaited<ReturnType<typeof fixture>>, targetRef: string) => git(h.repo, 'log', '--reverse', '--format=%s', `${h.base}..${targetRef}`).then(out => out.split('\n'));
  const soon = { timeout: 20_000, interval: 20 };

  it('stops the train that runs, lands the submission on a train of its own, and has the others land on top of it', async () => {
    const h = await fixture();
    const landing = await h.configure([held(h).check]);
    const blocker = await h.member('blocker'), a = await h.member('a'), lead = await h.member('lead');
    await blocker.commit('block.txt', 'x\n'); await a.commit('a.txt', 'a\n'); await lead.commit('fix.txt', 'f\n');
    // A train is held at its check, and a submission waits behind it.
    const first = blocker.land();
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(1), soon);
    const second = a.land();
    await vi.waitFor(() => expect(h.waiting()).toBe(1), soon);
    // Nobody opens the gate: the check that runs is stopped, and the repair lands after one run of the checks on it alone.
    expect(await lead.land('the tip fails the build for everyone')).toMatchObject({ status: 'landed', commits: 1 });
    expect(await subjects(h, landing.targetRef)).toEqual(['fix.txt']);
    // The train that was stopped runs again with what it had and what waited behind it, in the order they had.
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(3), soon);
    expect(await h.branch()).toMatchObject({ waiting: 0, train: { submissions: 2, step: 'checking' } });
    expect((await h.branch()).train).not.toHaveProperty('front');
    await writeFile(h.gate, '');
    expect((await Promise.all([first, second])).map(report => report.status)).toEqual(['landed', 'landed']);
    expect(await subjects(h, landing.targetRef)).toEqual(['fix.txt', 'block.txt', 'a.txt']);
    // The ledger tells it: the train that made way, the one that carried the repair and why, and the one that ran again.
    const [again, own, stopped] = await h.trains();
    expect(stopped).toMatchObject({ outcome: 'preempted', submissions: [{ key: 'item-blocker', outcome: 'next' }], checks: [{ submissions: 1, passed: false, reason: expect.stringContaining('aborted') }] });
    expect(own).toMatchObject({ outcome: 'done', submissions: [{ key: 'item-lead', member: 'lead', outcome: 'landed', front: 'the tip fails the build for everyone' }], checks: [{ submissions: 1, passed: true }] });
    expect(again).toMatchObject({ outcome: 'done', head: await h.head(), submissions: [{ key: 'item-blocker', outcome: 'landed' }, { key: 'item-a', outcome: 'landed' }], checks: [{ submissions: 2, passed: true }] });
    expect([...stopped!.submissions, ...again!.submissions].some(entry => 'front' in entry)).toBe(false);
  }, 60_000);

  it('has the ones put there ride together in the order they came, without the others, and leaves a train that carries one of them to finish', async () => {
    const h = await fixture();
    const { check, second } = held(h);
    const landing = await h.configure([check]);
    const [one, two, three, a] = await Promise.all(['one', 'two', 'three', 'a'].map(name => h.member(name)));
    await one!.commit('slow.txt', 's\n'); await two!.commit('two.txt', '2\n'); await three!.commit('three.txt', '3\n'); await a!.commit('a.txt', 'a\n');
    // The train of the first repair is held at its check.
    const first = one!.land('the build is broken');
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(1), soon);
    const waits = a!.land();
    await vi.waitFor(() => expect(h.waiting()).toBe(1), soon);
    const next = two!.land('the repair needs a repair');
    await vi.waitFor(() => expect(h.waiting()).toBe(2), soon);
    const last = three!.land('and one more');
    await vi.waitFor(() => expect(h.waiting()).toBe(3), soon);
    // They are ahead of what waited before them and behind one another; the check that runs was not stopped for them.
    expect(queued(h)).toEqual(['item-two', 'item-three', 'item-a']);
    expect(await h.runs()).toHaveLength(1);
    expect(await h.branch()).toMatchObject({ waiting: 3, train: { submissions: 1, step: 'checking', checks: 1, front: true } });
    // Whoever watches the queue from outside sees which of them are there for what.
    const records = new LandingRecords(join(h.dir, 'workspaces.sqlite'));
    closes.push(async () => records.close());
    const panel = landingPanel(h.state, records.read(h.state.workflowId, 10));
    expect(panel.branches[0]!.live!.waiting.map(rider => [rider.key, rider.front])).toEqual([['item-two', 'the repair needs a repair'], ['item-three', 'and one more'], ['item-a', undefined]]);
    expect(panel.branches[0]!.live!.train!.riders).toMatchObject([{ key: 'item-one', front: 'the build is broken', state: 'stacked' }]);
    await writeFile(second, '');
    expect((await Promise.all([first, next, last, waits])).map(report => report.status)).toEqual(['landed', 'landed', 'landed', 'landed']);
    expect(await subjects(h, landing.targetRef)).toEqual(['slow.txt', 'two.txt', 'three.txt', 'a.txt']);
    // Three trains, none of which was stopped: the first repair, the two that came while it ran, and then the other.
    expect((await h.trains()).map(train => [train.outcome, train.submissions.map(entry => entry.key), train.submissions.map(entry => entry.front)])).toEqual([
      ['done', ['item-a'], [undefined]], ['done', ['item-two', 'item-three'], ['the repair needs a repair', 'and one more']], ['done', ['item-one'], ['the build is broken']]]);
    expect(await h.runs()).toHaveLength(3);
  }, 60_000);

  it('keeps them ahead of the others when the train that carries them hands one back, and answers one that fails the checks like any other', async () => {
    const h = await fixture();
    const second = join(h.dir, 'gate-2');
    // Fails with bad.txt on the train, and holds a train with slow.txt until the gate opens.
    const check = node(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(h.log)},process.cwd()+'\\n');if(fs.existsSync('bad.txt'))process.exit(1);`
      + `const wait=f=>{const t=setInterval(()=>{if(fs.existsSync(f))clearInterval(t)},10)};if(fs.existsSync('slow.txt'))wait(${JSON.stringify(second)})`);
    const landing = await h.configure([check]);
    const [one, bad, good, a] = await Promise.all(['one', 'bad', 'good', 'a'].map(name => h.member(name)));
    await one!.commit('slow.txt', 's\n'); await bad!.commit('bad.txt', 'b\n'); await good!.commit('good.txt', 'g\n'); await a!.commit('a.txt', 'a\n');
    const first = one!.land('the build is broken');
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(1), soon);
    const waits = a!.land();
    await vi.waitFor(() => expect(h.waiting()).toBe(1), soon);
    const fails = bad!.land('a repair that is none');
    await vi.waitFor(() => expect(h.waiting()).toBe(2), soon);
    const follows = good!.land('the repair');
    await vi.waitFor(() => expect(h.waiting()).toBe(3), soon);
    await writeFile(second, '');
    // The checks are the same for a submission at the head of the queue: the one that breaks them is turned back.
    expect(await fails).toMatchObject({ status: 'check_failed', targetRef: landing.targetRef });
    expect((await Promise.all([first, follows, waits])).map(report => report.status)).toEqual(['landed', 'landed', 'landed']);
    // The one behind it went back to the queue and boarded before the submission that was there first.
    expect(await subjects(h, landing.targetRef)).toEqual(['slow.txt', 'good.txt', 'a.txt']);
    expect((await h.trains()).map(train => train.submissions.map(entry => `${entry.key}:${entry.outcome}`))).toEqual([
      ['item-a:landed'], ['item-good:landed'], ['item-bad:check_failed', 'item-good:next'], ['item-one:landed']]);
  }, 60_000);
});

describe('the landing queue as someone outside the service sees it', () => {
  it('writes what waits and what the train is doing whenever the queue changes', async () => {
    const h = await fixture();
    await h.configure([h.logged('', true)]);
    const records = new LandingRecords(join(h.dir, 'workspaces.sqlite'));
    closes.push(async () => records.close());
    const read = () => records.read(h.state.workflowId, 10);
    // The service names a repository by its real path, which is not the temporary directory's on every system.
    const repository = await realpath(h.repo);
    expect(read()).toMatchObject({ landing: { batch: expect.any(Number) }, heads: [], live: [], trains: [] });
    const members = await Promise.all(['a', 'b', 'c'].map(name => h.member(name))), [a, b, c] = members;
    await Promise.all(members.map((member, index) => member.commit(`file-${index}.txt`, 'x\n')));
    // The first train is held at its check while two more submissions join the queue behind it.
    const before = records.version(), first = a!.land();
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(1), { timeout: 20_000, interval: 20 });
    const rest = [b!.land(), c!.land()];
    await vi.waitFor(() => expect(h.waiting()).toBe(2), { timeout: 20_000, interval: 20 });
    expect(records.version()).not.toBe(before);
    const held = read().live;
    // The branch does not exist before the first landing, so this train has no head to name as its base.
    expect(held).toMatchObject([{ repository, at: expect.any(Number), train: { since: expect.any(Number), step: 'checking', base: null, checks: [], checking: { submissions: 1, since: expect.any(Number) },
      riders: [{ key: 'item-a', member: 'a', workspace: a!.ws.id, headCommit: a!.submitted().headCommit, commits: 1, since: expect.any(Number), state: 'stacked' }] } }]);
    expect(held[0]!.waiting.map(rider => rider.key).sort()).toEqual(['item-b', 'item-c']);
    expect(held[0]!.waiting[0]).toMatchObject({ commits: 1, since: expect.any(Number), headCommit: expect.any(String) });
    await writeFile(h.gate, '');
    expect((await Promise.all([first, ...rest])).map(report => report.status)).toEqual(['landed', 'landed', 'landed']);
    // Nothing waits and no train runs: the record says so, and what the trains did is in the ledger beside it.
    await vi.waitFor(() => expect(read().live).toMatchObject([{ repository, waiting: [] }]), { timeout: 20_000, interval: 20 });
    const after = read();
    expect(after.live[0]!.train).toBeUndefined();
    expect(after.heads).toEqual([{ targetRef: after.landing!.targetRef, head: await h.head(), repository }]);
    expect(after.trains.map(train => train.submissions.length)).toEqual([2, 1]);
    // The dashboard's view of it.
    const panel = landingPanel(h.state, after);
    expect(panel).toMatchObject({ configured: true, batch: after.landing!.batch, submitted: [], returned: [], overridden: [] });
    expect(panel.branches).toMatchObject([{ repository, landed: await h.head(), firstBlamed: 0, live: { waiting: [] }, totals: { trains: 2, checks: 2, landed: 3, turnedBack: 0 },
      trains: [{ submissions: 2, landed: 2, next: 0, outcome: 'done', stacked: 2, turnedBack: [], checks: [{ submissions: 2, passed: true }] }, { submissions: 1, landed: 1 }] }]);
  });

  it('holds no queue of a service that is gone', async () => {
    const h = await fixture();
    await h.configure();
    const member = await h.member('a'); await member.commit('a.txt', 'x\n');
    expect(await member.land()).toMatchObject({ status: 'landed' });
    const path = join(h.dir, 'workspaces.sqlite'), records = new LandingRecords(path);
    closes.push(async () => records.close());
    await vi.waitFor(() => expect(records.read(h.state.workflowId, 1).live).toHaveLength(1), { timeout: 20_000, interval: 20 });
    await h.manager.close();
    const next = new WorkflowWorkspaces(path, join(h.dir, 'worktrees'));
    closes.push(() => next.close());
    expect(records.read(h.state.workflowId, 1)).toMatchObject({ live: [], trains: [{ outcome: 'done' }] });
  });
});

describe('the landing ledger', () => {
  it('writes down each train: what it carried, every run of the checks and what became of each submission', async () => {
    const h = await fixture();
    // Passes only while mine.txt and theirs.txt are not both there.
    await h.configure([h.logged(`if(fs.existsSync('mine.txt')&&fs.existsSync('theirs.txt')){console.error('both present');process.exit(3)}`, true)]);
    expect(await h.trains()).toEqual([]);
    const names = ['other-1.txt', 'mine.txt', 'theirs.txt', 'other-2.txt'];
    const members = await Promise.all(names.map((_, index) => h.member('m' + index)));
    await Promise.all(members.map((member, index) => member.commit(names[index]!, 'x\n')));
    const reports = await h.together(4, () => members.map(member => member.land()));
    expect(reports.map(report => report.status).sort()).toEqual(['check_failed', 'landed', 'landed', 'landed']);
    const trains = await h.trains();
    // Newest first: the train of what came after the one that failed, if anything did, the train of four, and the one that was held.
    const four = trains.find(train => train.submissions.length === 4)!, at = trains.indexOf(four);
    expect(trains.at(-1)!.submissions).toMatchObject([{ outcome: 'landed' }]);
    expect(four).toMatchObject({ repository: await realpath(h.repo), outcome: 'done', base: expect.any(String), head: expect.any(String), since: expect.any(Number), ms: expect.any(Number) });
    // The whole stack failed, and bisecting found the first submission that breaks it.
    expect(four.checks[0]).toMatchObject({ submissions: 4, passed: false, code: 3, command: expect.stringContaining(' -e '), ms: expect.any(Number), headCommit: expect.any(String) });
    expect(four.checks.length).toBeGreaterThanOrEqual(2);
    expect(four.checks.filter(probe => probe.passed).map(probe => probe.submissions).sort().at(-1)).toBe(four.submissions.filter(entry => entry.outcome === 'landed').length);
    // The order in which the four joined the queue is not fixed; the ledger keeps the order the train stacked them in.
    expect(four.submissions.map(entry => entry.member).sort()).toEqual(['m0', 'm1', 'm2', 'm3']);
    const failed = four.submissions.findIndex(entry => entry.outcome === 'check_failed'), culprit = four.submissions[failed]!;
    // Whichever of the two that clash came second is the one that failed.
    expect(['m1', 'm2']).toContain(culprit.member);
    expect(four.submissions.slice(0, failed).every(entry => entry.outcome === 'landed')).toBe(true);
    expect(four.submissions.slice(failed + 1).every(entry => entry.outcome === 'next')).toBe(true);
    const loser = members[names.indexOf(culprit.member === 'm1' ? 'mine.txt' : 'theirs.txt')]!;
    expect(culprit).toMatchObject({ key: 'item-' + culprit.member, workspace: loser.ws.id, headCommit: loser.submitted().headCommit, commits: 1 });
    expect(JSON.stringify(four)).not.toContain('"checked"');
    // What rode on lands with the next train, which is in the ledger as well.
    const rode = four.submissions.length - failed - 1;
    expect(at).toBe(rode ? 1 : 0);
    if (rode) expect(trains[0]!.submissions.map(entry => entry.outcome)).toEqual(Array(rode).fill('landed'));
    // The main agent sees the latest trains in short, and how long a check that passed usually takes.
    const branch = await h.branch();
    expect(branch.recent).toHaveLength(trains.length);
    expect(branch.recent![at]).toMatchObject({ submissions: 4, landed: failed, outcome: 'done', turnedBack: [{ key: culprit.key, member: culprit.member, status: 'check_failed' }],
      checks: expect.arrayContaining([{ submissions: 4, seconds: expect.any(Number), passed: false }]) });
    expect(branch.recent!.at(-1)!.turnedBack).toBeUndefined();
    expect(branch.usualCheckSeconds).toEqual(expect.any(Number));
    // Asking for the ledger changes nothing, and is bounded.
    expect(((await h.manager.configure(h.ctx, { trains: 1 })) as LandingChange)).toMatchObject({ changed: false, trains: [{ outcome: 'done' }] });
    await expect(h.manager.configure(h.ctx, { trains: 0 })).rejects.toThrow('between 1 and 100');
  }, 60_000);

  it('tells the main agent of a check that runs far longer than the ones that passed lately, while it still runs', async () => {
    const h = await fixture({ slowCheckFactor: 2, slowCheckExtraMs: 250 });
    const second = join(h.dir, 'gate-2');
    await h.configure([h.logged(`if(fs.existsSync('slow.txt')){const s=setInterval(()=>{if(fs.existsSync(${JSON.stringify(second)}))clearInterval(s)},10)}`)]);
    const notices: Array<{ notice: string; halted: boolean }> = [];
    const submit = (member: { ws: WorkspaceBinding }, name: string) => h.manager.land(h.ctx, { workspace: member.ws.id, taskId: name,
      submitted: () => ({ key: 'item-' + name, member: name }), noticed: (notice, halted) => { notices.push({ notice, halted }); } });
    // Too few checks have passed to say how long one takes: nothing is reported, however long this one takes.
    const quick = await Promise.all(['q1', 'q2', 'q3'].map(name => h.member(name)));
    for (const [index, member] of quick.entries()) { await member.commit(`quick-${index}.txt`, 'x\n'); expect(await submit(member, 'q' + (index + 1))).toMatchObject({ status: 'landed' }); }
    expect(notices).toEqual([]);
    expect((await h.branch()).usualCheckSeconds).toEqual(expect.any(Number));
    const slow = await h.member('slow'); await slow.commit('slow.txt', 's\n');
    const landing = submit(slow, 'slow');
    await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 30_000, interval: 20 });
    expect(notices[0]!.halted).toBe(false);
    expect(notices[0]!.notice).toContain('检查已经跑了');
    expect(notices[0]!.notice).toContain('前 1 笔');
    expect(notices[0]!.notice).toContain('item-slow（slow）');
    expect(notices[0]!.notice).toContain('withdraw_work');
    // It is told once for the run, and the run goes on: the check is slow, not failed.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(notices).toHaveLength(1);
    await writeFile(second, '');
    expect(await landing).toMatchObject({ status: 'landed' });
    expect((await h.trains(1))[0]).toMatchObject({ outcome: 'done', submissions: [{ key: 'item-slow', outcome: 'landed' }], checks: [{ submissions: 1, passed: true, slow: true }] });
    expect((await h.branch()).recent![0]!.checks).toEqual([{ submissions: 1, seconds: expect.any(Number), passed: true, slow: true }]);
  }, 60_000);
});

describe('changing the landing while the workflow runs', () => {
  const fails = (name: string) => node(`if(require('fs').existsSync(${JSON.stringify(name)})){console.error(${JSON.stringify(name + ' is here')});process.exit(4)}`);

  it('reports the landing and refuses to change one the script has not configured', async () => {
    const h = await fixture();
    await expect(h.manager.configure(h.ctx, {})).rejects.toThrow('not configured');
    const landing = await h.configure([h.logged()], { batch: 4, protect: [{ paths: ['expected'] }] });
    const a = await h.member('a');
    expect(await h.manager.configure(h.ctx, {})).toEqual({ changed: false, landing: { targetRef: landing.targetRef, checks: landing.commands, protect: [{ paths: ['expected'], allow: [] }], batch: 4, overridden: [],
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
    await a.update();
    await git(a.ws.path, 'rm', '-q', 'bad.txt'); await git(a.ws.path, 'commit', '-q', '-m', 'repair');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    expect(await h.manager.configure(h.ctx, { checks: [fails('bad.txt')], batch: 3 })).toMatchObject({ changed: true, landing: { batch: 3, overridden: ['checks', 'batch'] } });
    await a.update();
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

describe('handing commits to the landing queue', () => {
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
    const landing = await h.configure([node(`const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(t)},10)`)]);
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

  it('puts the commits the queue turned back into the worktree of whoever takes the item, and a worktree with nothing of its own at the tip', async () => {
    const h = await fixture();
    const landing = await h.configure([node(`if(require('fs').existsSync('bad.txt')){console.error('bad.txt present');process.exit(3)}`)]);
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    const place = (member: { ws: WorkspaceBinding }, taskId: string, commits?: string) => h.manager.position(h.ctx, { workspace: member.ws.id, taskId, ...(commits ? { commits } : {}) });
    const kept = async () => (await git(h.repo, 'for-each-ref', '--format=%(refname)', `refs/bridge-workflow/${h.ctx.state.workflowId}/work/`)).split('\n').filter(Boolean);
    await a.commit('bad.txt', 'x\n');
    const handed = handOff(h, a, 'a'), info = await handed.submitted, commits = `${info.targetCommit}..${info.headCommit}`;
    // The queue keeps the commits under a ref of their own while it answers for them, and after it turned them back.
    const ref = `refs/bridge-workflow/${h.ctx.state.workflowId}/work/${info.headCommit}`;
    expect(await kept()).toEqual([ref]);
    expect(await handed.report).toMatchObject({ status: 'check_failed' });
    // Other work lands meanwhile: a member with nothing of its own starts its next item at the tip.
    await b.commit('good.txt', 'g\n'); expect(await b.land()).toMatchObject({ status: 'landed' });
    const tip = await git(h.repo, 'rev-parse', landing.targetRef);
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(await place(a, 'a')).toEqual({ worktree: 'tip', headCommit: tip });
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(await place(a, 'a')).toEqual({ worktree: 'tip', headCommit: tip });
    // The item that came back starts on its commits as they were submitted, in the worktree of another member as well.
    expect(await place(a, 'a', commits)).toEqual({ worktree: 'commits', headCommit: info.headCommit });
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(info.headCommit);
    expect(await place(a, 'a', commits)).toEqual({ worktree: 'commits', headCommit: info.headCommit });
    expect(await place(b, 'b', commits)).toEqual({ worktree: 'commits', headCommit: info.headCommit });
    expect(await git(b.ws.path, 'ls-files')).toContain('bad.txt');
    // Repaired and submitted again they land on what landed meanwhile. What landed needs no ref of its own any more.
    await git(a.ws.path, 'rm', '-q', 'bad.txt'); await git(a.ws.path, 'commit', '-q', '-m', 'repair'); await a.commit('fixed.txt', 'f\n');
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 3 });
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n')).toEqual(expect.arrayContaining(['good.txt', 'fixed.txt']));
    await vi.waitFor(async () => expect(await kept()).toEqual([ref]), { timeout: 5000, interval: 20 });
    // A task that does not run in the worktree is not positioned.
    expect(await place(a, 'someone-else')).toBeUndefined();
  }, 60_000);

  it('leaves a worktree that would lose something by the move where it is, and says why', async () => {
    const h = await fixture();
    await h.configure();
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    const place = (commits?: string) => h.manager.position(h.ctx, { workspace: a.ws.id, taskId: 'a', ...(commits ? { commits } : {}) });
    await b.commit('b.txt', 'b\n'); expect(await b.land()).toMatchObject({ status: 'landed' });
    const tip = await h.head();
    // Work that is not committed.
    await writeFile(join(a.ws.path, 'draft.txt'), 'draft\n');
    expect(await place()).toMatchObject({ worktree: 'kept', headCommit: h.base, note: expect.stringContaining('uncommitted') });
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('?? draft.txt');
    // Commits of its own that are not on the branch, whether the item is new or one that came back.
    await git(a.ws.path, 'add', '.'); await git(a.ws.path, 'commit', '-q', '-m', 'draft');
    const own = await git(a.ws.path, 'rev-parse', 'HEAD');
    expect(await place()).toMatchObject({ worktree: 'kept', headCommit: own, note: expect.stringContaining(`git reset --hard ${tip}`) });
    expect(await place(`${h.base}..${tip}`)).toMatchObject({ worktree: 'kept', headCommit: own });
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(own);
    // Commits that are nowhere to be found.
    expect(await place(`${h.base}..${'1'.repeat(40)}`)).toMatchObject({ worktree: 'kept', note: expect.stringContaining('not in this repository') });
  }, 60_000);

  it('takes a worktree off the landing branch before it moves it, so the branch stays where the queue put it', async () => {
    const h = await fixture();
    const landing = await h.configure([node(`if(require('fs').existsSync('bad.txt')){console.error('bad.txt present');process.exit(3)}`)]);
    const [a, b] = await Promise.all([h.member('a'), h.member('b')]);
    await b.commit('good.txt', 'g\n'); expect(await b.land()).toMatchObject({ status: 'landed' });
    const tip = await git(h.repo, 'rev-parse', landing.targetRef);
    await a.commit('bad.txt', 'x\n');
    const handed = handOff(h, a, 'a'), info = await handed.submitted;
    expect(await handed.report).toMatchObject({ status: 'check_failed' });
    // The member switched to the branch, and now takes up the item whose commits the queue turned back.
    await git(a.ws.path, 'checkout', '-q', landing.targetRef.replace('refs/heads/', ''));
    expect(await h.manager.position(h.ctx, { workspace: a.ws.id, taskId: 'a', commits: `${info.targetCommit}..${info.headCommit}` })).toEqual({ worktree: 'commits', headCommit: info.headCommit });
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(info.headCommit);
    await expect(git(a.ws.path, 'symbolic-ref', '--quiet', 'HEAD')).rejects.toThrow();
    expect(await git(h.repo, 'rev-parse', landing.targetRef)).toBe(tip);
  }, 60_000);

  it('reports a failed check with commits the member can bring back, and still answers a conflict in its worktree at once', async () => {
    const h = await fixture();
    await h.configure([node(`if(require('fs').existsSync('bad.txt')){console.error('bad.txt present');process.exit(3)}`)]);
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
  }, 60_000);

  it('gives the commits back to the worktree, and not to the queue, when nobody answers for them as they join it', async () => {
    const h = await fixture();
    await h.configure([h.logged()]);
    const a = await h.member('a'); await a.commit('one.txt', '1\n');
    const mine = await git(a.ws.path, 'rev-parse', 'HEAD');
    // The claim the commits were submitted for ended while they were prechecked, say.
    await expect(h.manager.land(h.ctx, { workspace: a.ws.id, taskId: 'a', submitted: () => { throw new Error('This claim is stale'); } })).rejects.toThrow('This claim is stale');
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(mine);
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('');
    // No train ran for them.
    expect(await h.runs()).toHaveLength(0);
    // The worktree submits again as if nothing had been.
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1, headCommit: mine });
  }, 60_000);

  it('stops the precheck of a submission when the service closes', async () => {
    const h = await fixture();
    await h.configure(undefined, { precheck: [h.logged('', true)] });
    const a = await h.member('a'); await a.commit('one.txt', '1\n');
    const mine = await git(a.ws.path, 'rev-parse', 'HEAD');
    await rm(join(h.dir, 'gate'), { force: true });
    const report = a.land(); void report.catch(() => {});
    await vi.waitFor(async () => expect(await h.runs()).toHaveLength(1), { timeout: 20_000, interval: 20 });
    const started = Date.now();
    await h.manager.close();
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(report).rejects.toThrow();
    // The commits are where the member made them.
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(mine);
  }, 60_000);
});

describe('submit_work', () => {
  type Landed = { workspace: string; taskId: string; submitted?: (info: LandSubmitted) => { key?: string; member?: string } | void; noticed?: (notice: string, halted: boolean) => void; front?: string };
  type Withdrawal = { headCommit: string; reason: string };
  type Placing = { workspace: string; taskId: string; commits?: string };
  type Placed = { worktree: 'tip' | 'commits' | 'kept'; headCommit: string; note?: string } | undefined;
  function harness(land: (input: Landed, signal: AbortSignal) => Promise<unknown>, landing?: (input: Record<string, unknown>) => Promise<unknown>, path = ':memory:',
    withdraw?: (input: Withdrawal) => 'withdrawn' | 'landing' | 'absent', position?: (input: Placing) => Promise<Placed>) {
    let now = 1_000_000;
    const root: WorkflowRoot = { scopeId: 'submit-test', profile: 'default', agentKind: 'codex', cwdRealpath: '/workspace', policyFingerprint: 'policy', catalogBinding: 'root', modelSettings: {} };
    const requests: WorkflowWorkerRequest[] = [];
    const finishers: Array<(result: WorkflowWorkerResult) => void> = [];
    const kernel = new WorkflowKernel(path, { resolveRoot: async () => root, wakeMain: async () => {}, resolveWorkspace: async () => {},
      land: async (_state, input, signal) => land(input, signal), ...(landing ? { landing: async (_state: unknown, input: Record<string, unknown>) => landing(input) } : {}),
      ...(withdraw ? { withdraw: async (_state: unknown, input: Withdrawal) => withdraw(input) } : {}),
      ...(position ? { position: async (_state: unknown, input: Placing) => position(input) } : {}),
      execute: async request => { requests.push(request); request.onRun('run-' + request.attemptId); request.onSession('native');
        return new Promise<WorkflowWorkerResult>(resolve => { finishers.push(resolve); request.signal.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true }); }); } }, () => now);
    closes.push(() => kernel.close());
    const state = () => kernel.state(root.scopeId)!;
    const send = (request: WorkflowWorkerRequest, method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'worker', scopeId: root.scopeId,
      workflowId: state().workflowId, taskId: request.task.taskId, attemptId: request.attemptId }, method, { operationId: randomUUID(), ...args });
    /** Calls with the arguments as they are, as a member that names no operationId does. */
    const raw = (request: WorkflowWorkerRequest, method: string, args: Record<string, unknown> = {}) => kernel.call({ kind: 'worker', scopeId: root.scopeId,
      workflowId: state().workflowId, taskId: request.task.taskId, attemptId: request.attemptId }, method, args);
    return { kernel, state, requests, send, raw, advance: (ms: number) => { now += ms; },
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

  it('completes the claimed item when the worktree holds nothing to land, and answers a repeat from the record', async () => {
    const lands: string[] = [];
    const h = harness(async input => { lands.push(input.workspace); return { status: 'landed', targetRef: 'refs/heads/x', headCommit: 'abc', commits: 0 }; });
    const request = await h.start('ws-1');
    const grant = await h.send(request, 'claim_work') as Grant;
    const operationId = 'submit-1';
    const landed = await h.send(request, 'submit_work', { operationId, claimId: grant.claimId, generation: grant.generation });
    expect(landed).toMatchObject({ status: 'landed', headCommit: 'abc', commits: 0, item: { status: 'completed' } });
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed', result: { headCommit: 'abc', commits: 0 } });
    expect(await h.send(request, 'submit_work', { operationId, claimId: grant.claimId, generation: grant.generation })).toMatchObject({ status: 'landed', item: { status: 'completed' } });
    expect(lands).toEqual(['ws-1']);
    // Without a claim there is nothing to complete, and no item is added for no commits.
    expect(await h.send(request, 'submit_work')).toMatchObject({ status: 'landed', commits: 0 });
    expect(lands).toHaveLength(2);
    expect(h.state().workQueue!.items).toHaveLength(1);
  });

  it('leaves the claim with the member when its worktree turns the commits back, and keeps it leased while the precheck runs', async () => {
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
    expect(h.state().workQueue!.claims[0]!.landing).toBeUndefined();
    expect(await h.send(request, 'release_claim', { claimId: grant.claimId, generation: grant.generation, reason: 'cannot fix' })).toMatchObject({ status: 'pending' });
  });

  it('answers that the worktree is still being prepared when that outlasts the wait, and keeps the answer until the member has read it', async () => {
    const lands: Landed[] = [], releases: Array<(report: unknown) => void> = [];
    const h = harness(input => { lands.push(input); return new Promise(resolve => { releases.push(resolve); }); });
    const request = await h.start('ws-1');
    const grant = await h.send(request, 'claim_work') as Grant;
    const submit = (operationId: string, waitSeconds = 0) => h.send(request, 'submit_work', { operationId, claimId: grant.claimId, generation: grant.generation, waitSeconds });
    expect(await submit('submit-1')).toEqual({ status: 'preparing', operationId: 'submit-1', seconds: expect.any(Number) });
    // The rebase and the precheck go on without a caller; a repeat waits for them, and so does a call under another operationId.
    expect(await submit('submit-1')).toMatchObject({ status: 'preparing', operationId: 'submit-1' });
    expect(await submit('submit-2')).toMatchObject({ status: 'preparing', operationId: 'submit-1' });
    expect(lands).toHaveLength(1);
    // The claim stays the member's, and leased, though no call is open.
    h.advance(100_000); await h.kernel.tick();
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'claimed' });
    expect(h.state().workQueue!.claims[0]!.landing).toBeUndefined();
    // The commits join the queue while nobody waits. The member that submits the item again has yet to read that, and is told so.
    lands[0]!.submitted!({ targetRef: 'refs/heads/x', targetCommit: 'aaa', headCommit: 'bbb', commits: 1, worktree: 'reset' });
    expect(await submit('submit-3')).toMatchObject({ status: 'submitted', key: 'bug-1', headCommit: 'bbb', operationId: 'submit-1' });
    const again = await submit('submit-1') as Record<string, unknown>;
    expect(again).toMatchObject({ status: 'submitted', key: 'bug-1', headCommit: 'bbb' });
    expect(again.operationId).toBeUndefined();
    // It has read it now: the item is the queue's, and another submission of it is refused.
    await expect(submit('submit-4')).rejects.toThrow('with the landing queue');
    expect(lands).toHaveLength(1);
    releases[0]!({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'ccc', commits: 1 });
    await vi.waitFor(() => expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed', result: { headCommit: 'ccc' } }));
    await expect(h.send(request, 'submit_work', { waitSeconds: 3601 })).rejects.toThrow();
  });

  it('keeps the answer of a submission its worktree turned back for a repeat, and submits anew under a new operationId once it was read', async () => {
    const releases: Array<{ resolve(report: unknown): void; reject(error: unknown): void }> = [];
    const h = harness(() => new Promise((resolve, reject) => { releases.push({ resolve, reject }); }));
    const request = await h.start('ws-1');
    const submit = (operationId: string, waitSeconds = 0) => h.send(request, 'submit_work', { operationId, waitSeconds });
    expect(await submit('one')).toMatchObject({ status: 'preparing' });
    releases[0]!.resolve({ status: 'check_failed', targetRef: 'refs/heads/x', targetCommit: 'abc', headCommit: 'def', commands: [{ argv: ['test'], code: 1, stdout: '', stderr: 'boom' }] });
    expect(await submit('one', 5)).toMatchObject({ status: 'check_failed', commands: [{ stderr: 'boom' }] });
    expect(await submit('one')).toMatchObject({ status: 'check_failed' });
    expect(releases).toHaveLength(1);
    // The repair goes in under a new operationId. What fails there for a reason that is not the member's is kept the same way.
    expect(await submit('two')).toMatchObject({ status: 'preparing', operationId: 'two' });
    expect(releases).toHaveLength(2);
    releases[1]!.reject(new Error('Could not rebase: the repository is locked'));
    await expect(submit('two', 5)).rejects.toThrow('the repository is locked');
    await expect(submit('two')).rejects.toThrow('the repository is locked');
    // An answer nobody has read is what the next call is given, whatever it names, and says which submission it is of.
    expect(await submit('three')).toMatchObject({ status: 'preparing', operationId: 'three' });
    releases[2]!.resolve({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'abc', commits: 0 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await submit('four')).toMatchObject({ status: 'landed', commits: 0, operationId: 'three' });
    expect(releases).toHaveLength(3);
    // Once it was read a call submits anew, and so does one that names nothing at all.
    expect(await h.raw(request, 'submit_work', { waitSeconds: 0 })).toMatchObject({ status: 'preparing' });
    expect(releases).toHaveLength(4);
    expect(await h.raw(request, 'submit_work', { waitSeconds: 0 })).toMatchObject({ status: 'preparing' });
    expect(releases).toHaveLength(4);
    // Nothing joined the queue, so nothing was added to follow it.
    expect(h.state().workQueue!.items).toHaveLength(1);
  });

  describe('once the commits are with the queue', () => {
    type Taken = Grant & { item: { key: string; landing?: { status: string } } };
    const joined = (targetCommit: string, headCommit: string): LandSubmitted => ({ targetRef: 'refs/heads/x', targetCommit, headCommit, commits: 1, worktree: 'reset' });
    /** A landing queue that takes every submission and answers when the test says so. */
    function queue(path?: string) {
      const lands: Landed[] = [], answers: Array<{ resolve(report: unknown): void; reject(error: unknown): void }> = [];
      /** The commits each submission joined the queue with, what was asked to be withdrawn, and how the queue answers that. */
      const heads: string[] = [], withdrawn: Withdrawal[] = [], gives = { up: 'withdrawn' as 'withdrawn' | 'landing' | 'absent' };
      const h = harness(input => { lands.push(input); return new Promise((resolve, reject) => { answers.push({ resolve, reject }); }); }, undefined, path, input => {
        withdrawn.push(input);
        const at = heads.indexOf(input.headCommit);
        if (at < 0) return 'absent';
        if (gives.up === 'withdrawn') answers[at]!.resolve({ status: 'withdrawn', targetRef: 'refs/heads/x', targetCommit: 'aaa', headCommit: input.headCommit, reason: input.reason });
        return gives.up;
      });
      const item = (key = 'bug-1') => h.state().workQueue!.items.find(item => item.key === key)!;
      /** What each submission told the queue it is for, as it joined. */
      const labels: unknown[] = [];
      /** The member submits the item it holds; the queue takes it as the commits `targetCommit..headCommit`. */
      const handOff = async (request: WorkflowWorkerRequest, grant: Grant, operationId: string, targetCommit: string, headCommit: string) => {
        const pending = h.send(request, 'submit_work', { operationId, claimId: grant.claimId, generation: grant.generation, result: { fixed: operationId } });
        const at = lands.length;
        await vi.waitFor(() => expect(lands).toHaveLength(at + 1));
        heads[at] = headCommit;
        labels.push(lands[at]!.submitted!(joined(targetCommit, headCommit)));
        return pending;
      };
      return { ...h, lands, answers, item, handOff, withdrawn, gives, labels };
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

    it('takes commits out of the queue for the member that submitted them and for the main agent, and returns the item with who did it and why', async () => {
      const h = queue();
      const request = await h.start('ws-1');
      const grant = await h.send(request, 'claim_work') as Taken;
      await h.handOff(request, grant, 'submit-1', 'aaa', 'bbb');
      // The queue was told what the commits are for and whose they are.
      expect(h.labels).toEqual([{ key: 'bug-1', member: 'fixer' }]);
      await expect(h.send(request, 'withdraw_work', { key: 'bug-1' })).rejects.toThrow('reason');
      await expect(h.send(request, 'withdraw_work', { key: 'bug-1', reason: 'x', force: true })).rejects.toThrow('Unsupported withdraw_work option');
      expect(await h.send(request, 'withdraw_work', { key: 'bug-1', reason: 'the new test takes 40 minutes' })).toEqual({ status: 'withdrawn', itemId: h.item().id, key: 'bug-1', member: 'fixer', commits: 'aaa..bbb' });
      expect(h.withdrawn).toEqual([{ headCommit: 'bbb', reason: 'Withdrawn by fixer: the new test takes 40 minutes' }]);
      // The item is the member's again by the time the call answers, with the reason, and no attempt of its is used up.
      expect(h.item()).toMatchObject({ status: 'pending', assignee: 'fixer', landing: { status: 'withdrawn', commits: 'aaa..bbb', reason: 'Withdrawn by fixer: the new test takes 40 minutes' } });
      expect(h.item().failures).toBeUndefined();
      // The queue no longer holds it: a repeat says how the item stands and asks the queue nothing.
      expect(await h.send(request, 'withdraw_work', { key: 'bug-1', reason: 'again' })).toMatchObject({ status: 'absent', key: 'bug-1', item: 'pending', landing: 'withdrawn' });
      expect(h.withdrawn).toHaveLength(1);
      const again = await h.send(request, 'claim_work') as Taken;
      expect(again.item).toMatchObject({ key: 'bug-1', landing: { status: 'withdrawn' } });
      await h.handOff(request, again, 'submit-2', 'ccc', 'ddd');
      expect(await h.kernel.call({ kind: 'main', scopeId: 'submit-test' }, 'withdraw_work', { itemId: h.item().id, reason: 'breaks the build' })).toMatchObject({ status: 'withdrawn', key: 'bug-1', commits: 'ccc..ddd' });
      expect(h.item()).toMatchObject({ status: 'pending', landing: { status: 'withdrawn', reason: 'Withdrawn by the main agent: breaks the build' } });
    });

    it('lets a lead put its commits at the head of the queue, and no other member', async () => {
      const h = queue();
      const fixer = await h.start('ws-1');
      const grant = await h.send(fixer, 'claim_work') as Taken;
      // A member that leads nothing is refused before anything is done with its worktree, and keeps its claim.
      await expect(h.send(fixer, 'submit_work', { claimId: grant.claimId, generation: grant.generation, front: 'the build is broken' })).rejects.toThrow('Only a lead (of the swarm or of one of its queues) puts commits at the head of the landing queue');
      await expect(h.send(fixer, 'submit_work', { front: ' ' })).rejects.toThrow('front must be nonempty text');
      expect(h.lands).toHaveLength(0);
      await h.handOff(fixer, grant, 'submit-1', 'aaa', 'bbb');
      expect(h.lands[0]).not.toHaveProperty('front');
      expect(h.state().workQueue!.claims[0]!.landing).toEqual({ since: expect.any(Number), targetCommit: 'aaa', headCommit: 'bbb', commits: 1 });
      // The lead of a swarm may, and so may the lead of one of its queues; a member of the swarm that leads nothing may not.
      await h.kernel.scriptWork('submit-test', h.state().workflowId, h.state().script!.runId, { kind: 'swarm', key: 'crew', task: 'Fix bugs', maxTurns: 4,
        lead: { name: 'boss', workspace: 'ws-boss' }, members: [{ name: 'keeper', workspace: 'ws-keeper', leads: ['gate'] }, { name: 'hand', workspace: 'ws-hand', queue: 'gate' }] });
      await h.kernel.scriptWork('submit-test', h.state().workflowId, h.state().script!.runId, { kind: 'enqueue', key: 'gate-1', title: 'gate-1', input: {}, queue: 'gate' });
      const turn = (name: string) => h.requests.find(request => h.state().agents!.find(agent => agent.agentId === request.task.agentId)?.key === name);
      await vi.waitFor(async () => { await h.kernel.tick(); expect(['boss', 'keeper', 'hand'].map(name => Boolean(turn(name)))).toEqual([true, true, true]); });
      await expect(h.send(turn('hand')!, 'submit_work', { front: 'mine is urgent' })).rejects.toThrow('Only a lead');
      expect(h.lands).toHaveLength(1);
      const submitting = [h.send(turn('boss')!, 'submit_work', { front: '  the tip fails the build for everyone ' }), h.send(turn('keeper')!, 'submit_work', { front: 'the gate script rejects every header' })];
      await vi.waitFor(() => expect(h.lands).toHaveLength(3));
      expect(h.lands.slice(1).map(input => [input.workspace, input.front]).sort()).toEqual([['ws-boss', 'the tip fails the build for everyone'], ['ws-keeper', 'the gate script rejects every header']]);
      // The reason goes with the commits: the member is answered with it, and the claim the queue holds says it.
      const boss = h.lands.findIndex(input => input.workspace === 'ws-boss');
      h.lands[boss]!.submitted!(joined('bbb', 'ccc'));
      expect(await submitting[0]).toMatchObject({ status: 'submitted', key: 'submitted-ccc', targetCommit: 'bbb', headCommit: 'ccc', front: 'the tip fails the build for everyone' });
      expect(h.state().workQueue!.claims.find(claim => claim.landing?.headCommit === 'ccc')!.landing).toMatchObject({ front: 'the tip fails the build for everyone' });
    });

    it('lets no other member withdraw commits, and says when a train is already landing them or the queue has lost them', async () => {
      const h = queue();
      const request = await h.start('ws-1');
      const grant = await h.send(request, 'claim_work') as Taken;
      await h.handOff(request, grant, 'submit-1', 'aaa', 'bbb');
      await h.kernel.scriptAgent('submit-test', h.state().workflowId, h.state().script!.runId, { key: 'turn-2', member: 'other', prompt: 'Fix another bug', workspace: 'ws-2' });
      await h.kernel.tick(); await vi.waitFor(() => expect(h.requests).toHaveLength(2));
      await expect(h.send(h.requests[1]!, 'withdraw_work', { key: 'bug-1', reason: 'not mine' })).rejects.toThrow('withdrawn from the landing queue by the member that submitted them');
      expect(h.withdrawn).toHaveLength(0);
      // Whoever plans the item's queue may, as the lead of a swarm does; having added the item is not enough.
      const view = h.state() as unknown as Parameters<typeof submittedCommits>[0];
      expect(submittedCommits(view, { key: 'bug-1' }, () => 'plans')).toMatchObject({ key: 'bug-1', member: 'fixer', targetCommit: 'aaa', headCommit: 'bbb' });
      expect(() => submittedCommits(view, { key: 'bug-1' }, () => 'added')).toThrow('withdrawn from the landing queue by');
      expect(submittedCommits(view, { key: 'bug-1' }, () => undefined, claim => claim.taskId === request.task.taskId)).toMatchObject({ headCommit: 'bbb' });
      h.gives.up = 'landing';
      expect(await h.send(request, 'withdraw_work', { key: 'bug-1', reason: 'too late' })).toMatchObject({ status: 'landing', key: 'bug-1' });
      h.gives.up = 'absent';
      expect(await h.send(request, 'withdraw_work', { key: 'bug-1', reason: 'gone' })).toMatchObject({ status: 'absent', key: 'bug-1' });
      // Either way the item stays with the queue, whose answer decides it.
      expect(h.item()).toMatchObject({ status: 'claimed' });
      h.answers[0]!.resolve({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'ccc', commits: 1 });
      await vi.waitFor(() => expect(h.item()).toMatchObject({ status: 'completed' }));
      expect(await h.send(request, 'withdraw_work', { key: 'bug-1', reason: 'landed' })).toMatchObject({ status: 'absent', item: 'completed' });
    });

    it('adds an item for commits a member submits for none, completes it when they land and returns it when they are turned back', async () => {
      const h = queue();
      const request = await h.start('ws-1');
      // The member holds nothing: it has finished the item it had.
      const grant = await h.send(request, 'claim_work') as Taken;
      await h.send(request, 'complete_work', { claimId: grant.claimId, generation: grant.generation, result: 1 });
      const free = async (operationId: string, targetCommit: string, headCommit: string) => {
        const pending = h.send(request, 'submit_work', { operationId }), at = h.lands.length;
        await vi.waitFor(() => expect(h.lands).toHaveLength(at + 1));
        h.lands[at]!.submitted!(joined(targetCommit, headCommit));
        return pending as Promise<{ status: string; key: string; itemId: string }>;
      };
      const head = 'b'.repeat(40), first = await free('free-1', 'aaa', head);
      expect(first).toEqual({ status: 'submitted', itemId: expect.any(String), key: 'submitted-bbbbbbbbbbbb', targetCommit: 'aaa', headCommit: head, commits: 1, worktree: 'reset' });
      expect(h.item(first.key)).toMatchObject({ id: first.itemId, status: 'claimed', by: 'fixer', assignee: 'fixer', input: { commits: `aaa..${head}`, count: 1 } });
      expect(h.state().workQueue!.claims.find(claim => claim.itemId === first.itemId)).toMatchObject({ status: 'active', landing: { targetCommit: 'aaa', headCommit: head } });
      // A repeat reads the answer and adds nothing.
      expect(await h.send(request, 'submit_work', { operationId: 'free-1' })).toEqual(first);
      expect(h.lands).toHaveLength(1);
      h.answers[0]!.resolve({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'ccc', commits: 1 });
      await vi.waitFor(() => expect(h.item(first.key)).toMatchObject({ status: 'completed', result: { headCommit: 'ccc', commits: 1 }, doneBy: 'fixer' }));
      // The same commits submitted again get an item of their own; turned back, it is the member's to take up.
      const second = await free('free-2', 'ccc', head);
      expect(second.key).toBe('submitted-bbbbbbbbbbbb-2');
      h.answers[1]!.resolve({ status: 'conflict', targetRef: 'refs/heads/x', targetCommit: 'ddd', detail: 'CONFLICT (content): a.txt' });
      await vi.waitFor(() => expect(h.item(second.key)).toMatchObject({ status: 'pending', assignee: 'fixer', landing: { status: 'conflict', commits: `ccc..${head}` } }));
      const again = await h.send(request, 'claim_work') as Taken;
      expect(again.item).toMatchObject({ key: second.key, landing: { status: 'conflict' } });
    });

    it('submits what a call that names nothing brings for the item the member holds, and for an item of their own when it holds none', async () => {
      const h = queue();
      const request = await h.start('ws-1'); await h.enqueue('bug-2');
      const grant = await h.raw(request, 'claim_work') as Taken;
      expect(grant.item.key).toBe('bug-1');
      const first = h.raw(request, 'submit_work', { result: { fixed: 'bug-1' } });
      await vi.waitFor(() => expect(h.lands).toHaveLength(1));
      h.lands[0]!.submitted!(joined('aaa', 'b'.repeat(40)));
      expect(await first).toMatchObject({ status: 'submitted', key: 'bug-1' });
      expect(h.state().workQueue!.claims.find(claim => claim.id === grant.claimId)).toMatchObject({ status: 'active', landing: { headCommit: 'b'.repeat(40) } });
      // An item that is with the queue is not one the member holds: what it submits now gets an item of its own, which takes no result.
      await expect(h.raw(request, 'submit_work', { result: 1 })).rejects.toThrow('you hold none');
      const pending = h.raw(request, 'submit_work');
      await vi.waitFor(() => expect(h.lands).toHaveLength(2));
      h.lands[1]!.submitted!(joined('aaa', 'c'.repeat(40)));
      expect(await pending).toMatchObject({ status: 'submitted', key: 'submitted-cccccccccccc' });
    });

    it('tells the main agent of a branch that halts under commits that wait, and keeps their items with the queue', async () => {
      const h = queue();
      const request = await h.start('ws-1');
      const grant = await h.send(request, 'claim_work') as Taken;
      await h.handOff(request, grant, 'submit-1', 'aaa', 'bbb');
      const attention = () => h.state().events.filter(event => event.kind === 'landing_attention');
      h.lands[0]!.noticed!('落地已停止：x', true);
      h.lands[0]!.noticed!('落地已停止：x', true);
      expect(attention()).toHaveLength(1);
      expect(attention()[0]).toMatchObject({ summary: '落地已停止：x', subject: 'landing:halted', acknowledged: false });
      // The member's turn ends while the branch stays halted: the queue still has the commits, so the item is not returned.
      await h.finish(request);
      h.advance(300_000); await h.kernel.tick();
      expect(h.item()).toMatchObject({ status: 'claimed' });
      h.answers[0]!.resolve({ status: 'landed', targetRef: 'refs/heads/x', headCommit: 'ccc', commits: 1 });
      await vi.waitFor(() => expect(h.item()).toMatchObject({ status: 'completed' }));
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
    const reports = [{ ...halted, notice: '落地已停止：x' }, { ...halted, notice: '落地已停止：x' }];
    const h = harness(async input => {
      const report = reports.shift();
      if (report) return report;
      // The branch was adopted: the commits join the queue, and land with what the queue found on the branch.
      input.submitted!({ targetRef: 'refs/heads/x', targetCommit: 'abc', headCommit: 'def', commits: 1, worktree: 'reset' });
      return { status: 'landed', targetRef: 'refs/heads/x', headCommit: 'def', commits: 1, notice: '落地分支 x 有 1 个提交未经 submit_work 进入' };
    });
    const request = await h.start('ws-1');
    const grant = await h.send(request, 'claim_work') as Grant;
    const attention = () => h.state().events.filter(event => event.kind === 'landing_attention').map(event => event.summary);
    expect(await h.send(request, 'submit_work', { claimId: grant.claimId, generation: grant.generation })).toEqual(halted);
    expect(await h.send(request, 'submit_work', { claimId: grant.claimId, generation: grant.generation })).toEqual(halted);
    expect(attention()).toEqual(['落地已停止：x']);
    expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'claimed' });
    const answer = await h.send(request, 'submit_work', { claimId: grant.claimId, generation: grant.generation }) as Record<string, unknown>;
    expect(answer).toMatchObject({ status: 'submitted', key: 'bug-1' });
    expect(answer.notice).toBeUndefined();
    await vi.waitFor(() => expect(h.state().workQueue!.items[0]).toMatchObject({ status: 'completed' }));
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

  it('has claim_work put the worktree where the item starts, and grants the claim whatever becomes of the worktree', async () => {
    const places: Placing[] = [];
    const h = harness(async () => ({ status: 'landed' }), undefined, ':memory:', undefined, async input => { places.push(input); return { worktree: 'tip', headCommit: 'ttt' }; });
    const request = await h.start('ws-1');
    const grant = await h.raw(request, 'claim_work') as Grant;
    expect(grant).toMatchObject({ item: { key: 'bug-1' }, worktree: 'tip', worktreeHead: 'ttt' });
    expect(places).toEqual([{ workspace: 'ws-1', taskId: request.task.taskId }]);
    // The item it is at already is where its worktree is: a repeat hands the claim out again and moves nothing.
    expect(await h.raw(request, 'claim_work')).toMatchObject({ claimId: grant.claimId, generation: grant.generation });
    expect(places).toHaveLength(1);
    const failing = harness(async () => ({ status: 'landed' }), undefined, ':memory:', undefined, async () => { throw new Error('index.lock exists'); });
    const other = await failing.start('ws-1');
    expect(await failing.raw(other, 'claim_work')).toMatchObject({ item: { key: 'bug-1' }, worktree: 'kept', worktreeNote: expect.stringContaining('index.lock exists') });
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
    await expect(h.send(second, 'submit_work', { extra: 1 })).rejects.toThrow('Unsupported');
    expect(land).not.toHaveBeenCalled();
  });
});

describe('claim, fix and land through the runtime', () => {
  it.each(['worktree', 'clone'] as const)('runs the packaged example: members claim bugs, commit in their %ss and land fixes that clash over IPC', async isolation => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-claim-land-'));
    closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const repo = join(dir, 'repo'); await mkdir(repo);
    await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
    await writeFile(join(repo, 'README'), 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
    const root: WorkflowRoot = { scopeId: 'chat', profile: 'embedded', agentKind: 'custom-agent', cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'main', modelSettings: {} };
    const rejected: string[] = [], returned: string[] = [];
    // Where the host has the trains made, and where the checks say they ran.
    const trains = join(await realpath(dir), 'trains'), checked = join(dir, 'checked-in');
    const runtime = new WorkflowRuntime({ path: join(dir, 'workflows.sqlite'), resolveRoot: async () => root, wakeMain: async () => {}, authorizeWorkspace: async () => {},
      trainRoot: () => trains,
      runner: { async start(spec) {
        await spec.validateBeforeRun();
        const cwd = spec.workspace!.path;
        expect(spec.systemPrompt).toContain('Landing branch: bridge-workflow/');
        // A clone has refs of its own, so switching to a branch there holds nothing of the source.
        expect(spec.systemPrompt.includes('Do not switch this worktree to that branch (git checkout or git switch bridge-workflow/')).toBe(isolation !== 'clone');
        expect(spec.systemPrompt).toContain('Submit each item as soon as its own check passes');
        expect(spec.systemPrompt).toContain(`Managed ${isolation}: ${cwd}`);
        // A clone sees the landing branch through its remote; a worktree shares the checkout's refs.
        const refs = isolation === 'clone' ? `refs/remotes/${CLONE_REMOTE}/bridge-workflow` : 'refs/heads/bridge-workflow';
        /** One turn of a fixer: claim until there is nothing to claim. */
        const work = (async () => {
          for (;;) {
            const grant = await callWorkflow('claim_work', {}, spec.env) as { claimId: string; generation: number; item: { key: string; landing?: { status: string } } } | null;
            if (!grant) return;
            // A fix the queue turned back clashed with one that landed before it. claim_work put it into the worktree;
            // this fixer makes it again on what landed instead.
            if (grant.item.landing) returned.push(grant.item.landing.status);
            if (isolation === 'clone') await git(cwd, 'fetch', '--quiet', CLONE_REMOTE);
            const branch = (await git(cwd, 'for-each-ref', '--format=%(refname)', refs)).split('\n')[0];
            if (branch) await git(cwd, ...(grant.item.landing ? ['reset', '--hard', '--quiet'] : ['rebase']), branch);
            // Every fixer appends to the same file, so fixes made at the same time conflict and must be redone on the new head.
            for (;;) {
              await writeFile(join(cwd, 'fixed.txt'), (await readFile(join(cwd, 'fixed.txt'), 'utf8').catch(() => '')) + grant.item.key + '\n');
              await git(cwd, 'add', '.'); await git(cwd, '-c', 'user.name=Fixer', '-c', 'user.email=fixer@localhost', 'commit', '-m', grant.item.key);
              const report = await callWorkflow('submit_work', { result: { fixed: grant.item.key } }, spec.env) as { status: string; targetCommit: string };
              if (report.status === 'submitted') break;
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
      args: { members: 4, isolation, items: keys.map(key => ({ key, title: key })), checks: [{ argv: [process.execPath, '-e',
        `const fs=require('fs');fs.appendFileSync(${JSON.stringify(checked)},process.cwd()+'\\n');if(!fs.existsSync('fixed.txt'))process.exit(1)`] }] } }, main.env);
    main.release();
    await vi.waitFor(async () => { await runtime.tick(); expect(runtime.kernel.state(root.scopeId)?.script?.status).not.toBe('running'); }, { timeout: 100_000, interval: 100 });
    const state = runtime.kernel.state(root.scopeId)!;
    expect(state.script).toMatchObject({ status: 'result_ready' });
    const result = JSON.parse(state.artifacts.find(artifact => artifact.ref === state.script?.resultRef)!.text!) as { branch: string; queues: Record<string, unknown> };
    expect(result.queues).toMatchObject({ default: { completed: 12 } });
    // The checks ran in the train, and the train was where the runtime was told to make it.
    const ran = [...new Set((await readFile(checked, 'utf8')).trim().split('\n'))];
    expect(ran).toEqual([expect.stringMatching(/\/train-[a-f0-9]{16}$/)]);
    expect(ran[0]!.startsWith(join(trains, state.workflowId) + '/')).toBe(true);
    expect(state.workQueue!.items.map(item => item.result)).toEqual(expect.arrayContaining(keys.map(key => ({ fixed: key }))));
    // Every fix is on the branch exactly once, the history is linear, and the original checkout never moved.
    expect((await git(repo, 'show', `${result.branch}:fixed.txt`)).split('\n').sort()).toEqual([...keys].sort());
    expect(await git(repo, 'rev-list', '--count', `main..${result.branch}`)).toBe('12');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'main'));
    // A clash is answered in the member's worktree when the other fix has landed, and comes back from the queue when both waited in it.
    expect(rejected.every(status => status === 'conflict')).toBe(true);
    expect(returned.every(status => status === 'conflict')).toBe(true);
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
            const grant = await callWorkflow('claim_work', {}, spec.env) as { claimId: string; generation: number; worktree?: string; worktreeNote?: string; item: { key: string; landing?: { status: string; commits: string } } } | null;
            if (!grant) return;
            const { key, landing } = grant.item;
            if (landing) {
              // The queue turned this fix back: claim_work has put its commits into the worktree, to be repaired there.
              returned.push({ key, status: landing.status });
              expect(grant.worktree, grant.worktreeNote).toBe('commits');
              expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(landing.commits.split('..')[1]);
              await git(cwd, 'rm', '-q', 'broken.txt'); await commit(`${key}: repair`);
            } else {
              // A new item starts at the tip of the landing branch.
              expect(grant.worktree, grant.worktreeNote).toBe('tip');
              await writeFile(join(cwd, `fix-${key}.txt`), key + '\n');
              if (key === 'bug-3') await writeFile(join(cwd, 'broken.txt'), 'x\n');
              await git(cwd, 'add', '.'); await commit(key);
            }
            const report = await callWorkflow('submit_work', { result: { fixed: key } }, spec.env) as { status: string; targetCommit: string };
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
      args: { members: 3, isolation, items: keys.map(key => ({ key, title: key })),
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
