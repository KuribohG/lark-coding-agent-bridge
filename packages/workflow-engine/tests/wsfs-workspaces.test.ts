import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import { workspaceCommand } from '../src/engine/workspace-process';
import { WorkflowWorkspaces, type WorkspacePlaces } from '../src/engine/workspaces';
import type { WorkspaceBinding, WorkspaceLanding } from '../src/engine/workspace-types';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
const run = (command: string, argv: string[], cwd = tmpdir()) => workspaceCommand(command, argv, cwd, signal()).catch(() => ({ code: -1, stdout: '', stderr: '' }));
async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, signal());
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const exists = (path: string) => access(path).then(() => true, () => false);
/** The files below a directory, as paths from it. */
async function files(root: string, below = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, below), { withFileTypes: true }).catch(() => [])) {
    const path = join(below, entry.name);
    if (entry.isDirectory()) found.push(...await files(root, path)); else found.push(path);
  }
  return found;
}

// The binary is built from packages/workspace-fs when cargo is there (`npm run build:native`), and a mount needs
// FUSE: the suite runs where both are, and is skipped elsewhere.
const binary = process.env.WORKFLOW_WSFS_COMMAND || fileURLToPath(new URL('../../../bin/wsfs', import.meta.url));
const mounts = process.platform === 'linux' && existsSync(binary) && existsSync('/dev/fuse')
  && (await run('fusermount3', ['--version'])).code === 0;

async function fixture(places: WorkspacePlaces = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-wsfs-'));
  closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  // A test that failed leaves its daemon serving: nothing is deleted through a mount.
  closes.push(async () => {
    await run('pkill', ['-9', '-f', `wsfs mount .*${dir}/`]);
    const mounted = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').map(line => line.split(' ')[4] ?? '').filter(path => path.startsWith(dir + '/'));
    for (const path of mounted) await run('fusermount3', ['-u', '-z', path]);
  });
  const repo = join(dir, 'repo'); await mkdir(join(repo, 'src'), { recursive: true });
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Source Author'); await git(repo, 'config', 'user.email', 'source@localhost');
  await writeFile(join(repo, 'shared.txt'), 'baseline\n'); await writeFile(join(repo, 'src/code.txt'), 'code\n'); await writeFile(join(repo, '.gitignore'), 'build/\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const base = await git(repo, 'rev-parse', 'HEAD');
  const root = { scopeId: 'scope', profile: 'test', agentKind: 'codex' as const, cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'root', modelSettings: {} };
  const kernel = new WorkflowKernel(':memory:', { resolveRoot: async () => root, execute: async () => ({ status: 'completed' }), wakeMain: async () => {} });
  closes.push(() => kernel.close());
  await kernel.call({ kind: 'main', scopeId: 'scope', allowStart: true }, 'run_script', { operationId: 'start', goal: 'test', plan: 'test wsfs workspaces', script: 'return null;' });
  const state = kernel.state('scope')!;
  const open = () => { const manager = new WorkflowWorkspaces(join(dir, 'workspaces.sqlite'), join(dir, 'worktrees'), undefined, {}, places); closes.push(() => manager.close()); return manager; };
  const manager = open();
  const ctx = { state, signal: signal() };
  const op = <T>(kind: string, key: string, args: object = {}) => manager.perform(ctx, { kind, key, ...args }) as Promise<T>;
  /** A member's workspace with a turn running in it. */
  const member = async (name: string) => {
    const ws = await op<WorkspaceBinding>('create', name, { isolation: 'wsfs' });
    const token = manager.begin(ws, name);
    return { ws, land: () => manager.land(ctx, { workspace: ws.id, taskId: name }), idle: () => manager.end(ws, token),
      /** What the workspace holds of its own: the files wsfs keeps for it, which are those that differ from its commit. */
      own: async () => (await files(join(dir, 'worktrees', state.workflowId, `${ws.path.split('/').at(-2)}.state`, 'ws', ws.id, 'upper'))).sort(),
      commit: async (file: string, content: string) => { await writeFile(join(ws.path, file), content); await git(ws.path, 'add', '.'); await git(ws.path, 'commit', '-m', file); return git(ws.path, 'rev-parse', 'HEAD'); } };
  };
  const configure = () => op<WorkspaceLanding>('landing', 'landing-' + randomUUID(), { checks: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] });
  return { dir, repo, base, root, state, manager, open, ctx, op, member, configure };
}

describe.skipIf(!mounts)('wsfs workspaces', () => {
  it('shows the commit in a worktree of the repository without writing its files', async () => {
    const h = await fixture();
    const a = await h.member('a'), b = await h.member('b');
    expect(a.ws).toMatchObject({ isolation: 'wsfs', baseCommit: h.base, status: 'ready' });
    // Both are directories of the one mount the workflow has for the repository.
    expect(a.ws.path).toMatch(new RegExp(`/worktrees/${h.state.workflowId}/wsfs-[a-f0-9]{16}/${a.ws.id}$`));
    expect(b.ws.path.slice(0, b.ws.path.lastIndexOf('/'))).toBe(a.ws.path.slice(0, a.ws.path.lastIndexOf('/')));
    expect((await stat(join(a.ws.path, '.git'))).isFile()).toBe(true);
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(a.ws.path, 'src/code.txt'), 'utf8')).toBe('code\n');
    expect(await a.own()).toEqual([]);
    // It is a linked worktree: the repository lists it, and it shares the repository's refs.
    expect(await git(h.repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${a.ws.path}`);
    await git(a.ws.path, 'branch', 'mine');
    expect(await git(h.repo, 'branch', '--list', 'mine')).toContain('mine');
    // What one member writes is its own, and only that is stored.
    await writeFile(join(a.ws.path, 'src/code.txt'), 'changed\n'); await mkdir(join(a.ws.path, 'build')); await writeFile(join(a.ws.path, 'build/out.o'), 'object\n');
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('M src/code.txt');
    expect(await a.own()).toEqual(['build/out.o', 'src/code.txt']);
    expect(await readFile(join(b.ws.path, 'src/code.txt'), 'utf8')).toBe('code\n');
    expect(await readFile(join(h.repo, 'src/code.txt'), 'utf8')).toBe('code\n');
    // Repeating the operation answers from the record.
    expect(await h.op<WorkspaceBinding>('create', 'a', { isolation: 'wsfs' })).toMatchObject({ id: a.ws.id, path: a.ws.path });
  }, 60_000);

  it('lands commits by moving the workspace, which then holds none of the files that landed', async () => {
    const h = await fixture(); const landing = await h.configure();
    const a = await h.member('a'), b = await h.member('b');
    const first = await a.commit('a.txt', 'a\n');
    expect(await a.own()).toEqual(['a.txt']);
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1, headCommit: first });
    expect(await git(h.repo, 'rev-parse', landing.targetRef)).toBe(first);
    // b started before a landed: its commit is rebased onto the branch in the object database, and its build output stays.
    await mkdir(join(b.ws.path, 'build')); await writeFile(join(b.ws.path, 'build/out.o'), 'object\n');
    const mine = await b.commit('src/code.txt', 'from b\n');
    const second = await b.land() as { status: string; headCommit: string };
    expect(second).toMatchObject({ status: 'landed', commits: 1 });
    expect(second.headCommit).not.toBe(mine);
    expect(await git(h.repo, 'rev-parse', `${second.headCommit}^`)).toBe(first);
    expect(await git(h.repo, 'log', '-1', '--format=%an <%ae> %s', second.headCommit)).toBe('Source Author <source@localhost> src/code.txt');
    // Once the queue has its commits the workspace is left at the tip it rebased onto, for the member's next item.
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(first);
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(b.ws.path, 'a.txt'), 'utf8')).toBe('a\n');
    expect(await readFile(join(b.ws.path, 'src/code.txt'), 'utf8')).toBe('code\n');
    expect(await b.own()).toEqual(['build/out.o']);
    // The next item starts from there and lands on what the queue landed meanwhile.
    const untouched = (await stat(join(b.ws.path, 'shared.txt'))).mtimeMs;
    await b.commit('b2.txt', 'b2\n');
    const written = (await stat(join(b.ws.path, 'b2.txt'))).mtimeMs;
    const third = await b.land() as { status: string; headCommit: string };
    expect(third).toMatchObject({ status: 'landed', commits: 1 });
    // A file the moves changed is as new as the move, so a build makes again what it made from it; the others keep their time.
    expect((await stat(join(b.ws.path, 'src/code.txt'))).mtimeMs).toBeGreaterThan(written);
    expect((await stat(join(b.ws.path, 'shared.txt'))).mtimeMs).toBe(untouched);
    expect(await git(h.repo, 'rev-parse', landing.targetRef)).toBe(third.headCommit);
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(second.headCommit);
    expect(await readFile(join(b.ws.path, 'src/code.txt'), 'utf8')).toBe('from b\n');
    expect(await b.own()).toEqual(['build/out.o']);
    expect((await git(h.repo, 'ls-tree', '-r', '--name-only', landing.targetRef)).split('\n').sort()).toEqual(['.gitignore', 'a.txt', 'b2.txt', 'shared.txt', 'src/code.txt']);
  }, 60_000);

  it('reports a conflict with landed work and leaves the workspace as submitted', async () => {
    const h = await fixture(); await h.configure();
    const a = await h.member('a'), b = await h.member('b');
    await a.commit('shared.txt', 'from a\n'); const mine = await b.commit('shared.txt', 'from b\n');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    expect(await b.land()).toMatchObject({ status: 'conflict' });
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(mine);
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(b.ws.path, 'shared.txt'), 'utf8')).toBe('from b\n');
  }, 60_000);

  it('leaves the rebase to Git when the member works on a branch', async () => {
    const h = await fixture(); const landing = await h.configure();
    const a = await h.member('a'), b = await h.member('b');
    const first = await a.commit('a.txt', 'a\n');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    await git(b.ws.path, 'checkout', '--quiet', '-b', 'topic');
    await b.commit('b.txt', 'b\n');
    const second = await b.land() as { status: string; headCommit: string };
    expect(second).toMatchObject({ status: 'landed', commits: 1 });
    expect(await git(h.repo, 'rev-parse', landing.targetRef)).toBe(second.headCommit);
    // The branch moved with the workspace, as it does in a plain worktree.
    expect(await git(b.ws.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/topic');
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(first);
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('takes the landing branch from a workspace that switched to it, lands, and moves that workspace by its daemon again', async () => {
    const h = await fixture(); const landing = await h.configure();
    const a = await h.member('a'), b = await h.member('b');
    await a.commit('a.txt', 'a\n');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    const first = await git(h.repo, 'rev-parse', landing.targetRef);
    await git(b.ws.path, 'checkout', '--quiet', landing.targetRef.replace('refs/heads/', ''));
    await a.commit('more.txt', 'more\n');
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1 });
    const tip = await git(h.repo, 'rev-parse', landing.targetRef);
    expect(await git(h.repo, 'rev-parse', `${tip}~1`)).toBe(first);
    // Off the branch, on the commit it was on, and clean: on the branch it would show more.txt as deleted.
    await expect(git(b.ws.path, 'symbolic-ref', '--quiet', 'HEAD')).rejects.toThrow();
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(first);
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
    // With HEAD detached the daemon moves the workspace, and it keeps none of the files that landed.
    await b.commit('b.txt', 'b\n');
    expect(await b.land()).toMatchObject({ status: 'landed', commits: 1 });
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(await readFile(join(b.ws.path, 'more.txt'), 'utf8')).toBe('more\n');
    expect(await b.own()).toEqual([]);
  }, 60_000);

  it('puts a workspace where a claimed item starts by moving it, and prechecks a submission on the stacked commits', async () => {
    const h = await fixture();
    // The precheck records which files it ran on; the checks of the train turn back what holds bad.txt.
    const seen = join(h.dir, 'precheck.log');
    const landing = await h.op<WorkspaceLanding>('landing', 'landing-' + randomUUID(), {
      checks: [{ argv: [process.execPath, '-e', `if(require('fs').existsSync('bad.txt'))process.exit(3)`] }],
      precheck: [{ argv: [process.execPath, '-e', `const fs=require('fs');fs.appendFileSync(${JSON.stringify(seen)},fs.readdirSync('.').filter(n=>n.endsWith('.txt')).sort().join(',')+'\\n')`] }] });
    const a = await h.member('a'), b = await h.member('b');
    const place = (member: { ws: WorkspaceBinding }, taskId: string, commits?: string) => h.manager.position(h.ctx, { workspace: member.ws.id, taskId, ...(commits ? { commits } : {}) });
    await a.commit('a.txt', 'a\n');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    const first = await git(h.repo, 'rev-parse', landing.targetRef);
    // b started before that landed: its commit is stacked on the branch, and the precheck runs on the stack in its workspace.
    await mkdir(join(b.ws.path, 'build')); await writeFile(join(b.ws.path, 'build/out.o'), 'object\n');
    const mine = await b.commit('bad.txt', 'x\n');
    let info!: { targetCommit: string; headCommit: string };
    expect(await h.manager.land(h.ctx, { workspace: b.ws.id, taskId: 'b', submitted: joined => { info = joined; } })).toMatchObject({ status: 'check_failed' });
    expect((await readFile(seen, 'utf8')).trim().split('\n').at(-1)).toBe('a.txt,bad.txt,shared.txt');
    expect(info.targetCommit).toBe(first);
    expect(info.headCommit).not.toBe(mine);
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(first);
    // More lands meanwhile. A new item starts at the tip: the workspace is moved there, and holds no file of the commit.
    await a.commit('a2.txt', 'a2\n');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    const tip = await git(h.repo, 'rev-parse', landing.targetRef);
    expect(await place(b, 'b')).toEqual({ worktree: 'tip', headCommit: tip });
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(await readFile(join(b.ws.path, 'a2.txt'), 'utf8')).toBe('a2\n');
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
    expect(await b.own()).toEqual(['build/out.o']);
    // The item the queue turned back starts on its commits, in the workspace of another member as well.
    const commits = `${info.targetCommit}..${info.headCommit}`;
    expect(await place(b, 'b', commits)).toEqual({ worktree: 'commits', headCommit: info.headCommit });
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(info.headCommit);
    expect(await readFile(join(b.ws.path, 'bad.txt'), 'utf8')).toBe('x\n');
    expect(await access(join(b.ws.path, 'a2.txt')).then(() => true, () => false)).toBe(false);
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
    expect(await b.own()).toEqual(['build/out.o']);
    expect(await place(a, 'a', commits)).toEqual({ worktree: 'commits', headCommit: info.headCommit });
    expect(await readFile(join(a.ws.path, 'bad.txt'), 'utf8')).toBe('x\n');
    expect(await a.own()).toEqual([]);
    // A workspace with work that is not committed is left alone.
    await writeFile(join(a.ws.path, 'draft.txt'), 'draft\n');
    expect(await place(a, 'a')).toMatchObject({ worktree: 'kept', headCommit: info.headCommit });
    expect(await a.own()).toEqual(['draft.txt']);
    // Repaired where claim_work put them, the commits land on what landed meanwhile.
    await git(b.ws.path, 'rm', '-q', 'bad.txt'); await git(b.ws.path, 'commit', '-q', '-m', 'repair'); await b.commit('b.txt', 'b\n');
    expect(await b.land()).toMatchObject({ status: 'landed', commits: 3 });
    expect((await readFile(seen, 'utf8')).trim().split('\n').at(-1)).toBe('a.txt,a2.txt,b.txt,shared.txt');
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n').sort()).toEqual(['.gitignore', 'a.txt', 'a2.txt', 'b.txt', 'shared.txt', 'src']);
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(await b.own()).toEqual(['build/out.o']);
  }, 90_000);

  it('is served again after its daemon died, with what was not committed', async () => {
    const h = await fixture();
    const a = await h.member('a');
    await writeFile(join(a.ws.path, 'draft.txt'), 'not committed\n');
    expect((await run('pkill', ['-9', '-f', `wsfs mount .*${h.dir}/`])).code).toBe(0);
    await expect.poll(() => readFile(join(a.ws.path, 'draft.txt'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code), { timeout: 10_000 }).toBe('ENOTCONN');
    // Whoever is bound to the workspace finds it served; so does a service that starts after this one.
    const again = h.open();
    expect(await again.binding(h.root, h.state.workflowId, a.ws.id, signal())).toMatchObject({ id: a.ws.id, status: 'ready' });
    expect(await readFile(join(a.ws.path, 'draft.txt'), 'utf8')).toBe('not committed\n');
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('?? draft.txt');
  }, 60_000);

  it('removes a workspace with what it holds, and stops serving after the last one', async () => {
    const h = await fixture();
    const a = await h.member('a'), b = await h.member('b');
    const mount = a.ws.path.slice(0, a.ws.path.lastIndexOf('/'));
    await a.commit('a.txt', 'a\n'); await writeFile(join(b.ws.path, 'left.txt'), 'left\n');
    a.idle(); b.idle();
    expect(await h.op('cleanup', 'clean-a', { workspace: a.ws.id })).toMatchObject({ removed: true });
    expect(await exists(a.ws.path)).toBe(false);
    expect(await exists(join(h.repo, '.git/worktrees', a.ws.id))).toBe(false);
    // The other member is still served.
    expect(await readFile(join(b.ws.path, 'left.txt'), 'utf8')).toBe('left\n');
    expect(await h.op('cleanup', 'clean-b', { workspace: b.ws.id })).toMatchObject({ removed: true });
    expect(await git(h.repo, 'worktree', 'list', '--porcelain')).not.toContain(mount);
    expect((await readFile('/proc/self/mountinfo', 'utf8')).includes(mount)).toBe(false);
    for (const left of [mount, `${mount}.state`, `${mount}.json`]) expect(await exists(left)).toBe(false);
    expect((await run('pgrep', ['-f', `wsfs mount .*${h.dir}/`])).stdout.trim()).toBe('');
    // A workspace asked for afterwards is served by a new daemon.
    const c = await h.member('c');
    expect(await readFile(join(c.ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    c.idle();
    expect(await h.op('cleanup', 'clean-c', { workspace: c.ws.id })).toMatchObject({ removed: true });
  }, 60_000);

  it('checks what lands in a train workspace of the same kind, which goes with the last member', async () => {
    const h = await fixture();
    // The check passes only where the whole tree of the commit is there to read, and leaves a build directory behind.
    const check = 'const fs=require("fs");if(!fs.existsSync("src/code.txt"))process.exit(1);fs.mkdirSync("build",{recursive:true});fs.writeFileSync("build/checked",process.cwd())';
    const landing = await h.op<WorkspaceLanding>('landing', 'landing', { checks: [{ argv: [process.execPath, '-e', check] }] });
    const a = await h.member('a'), b = await h.member('b');
    const mount = a.ws.path.slice(0, a.ws.path.lastIndexOf('/')), train = join(mount, `train-${h.state.workflowId}`);
    await a.commit('a.txt', 'a\n'); await b.commit('b.txt', 'b\n');
    const [first, second] = await Promise.all([a.land(), b.land()]) as Array<{ status: string; headCommit: string }>;
    expect(first).toMatchObject({ status: 'landed' }); expect(second).toMatchObject({ status: 'landed' });
    const head = await git(h.repo, 'rev-parse', landing.targetRef);
    expect((await git(h.repo, 'ls-tree', '-r', '--name-only', head)).split('\n').sort()).toEqual(['.gitignore', 'a.txt', 'b.txt', 'shared.txt', 'src/code.txt']);
    // The checks ran in a workspace beside the members', which holds what they built and none of the checkout.
    expect(await readFile(join(train, 'build/checked'), 'utf8')).toBe(train);
    expect(await git(train, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(train, 'status', '--porcelain')).toBe('');
    expect(await files(join(`${mount}.state`, 'ws', `train-${h.state.workflowId}`, 'upper'))).toEqual(['build/checked']);
    expect(await exists(join(h.dir, 'worktrees', h.state.workflowId, 'train-' + mount.slice(mount.lastIndexOf('-') + 1)))).toBe(false);
    // A move is noted in the reflog, where a member finds the commits its workspace was moved away from.
    expect(await git(b.ws.path, 'reflog', '-1', '--format=%gs')).toContain('wsfs: moving to');
    a.idle(); b.idle();
    for (const member of [a, b]) expect(await h.op('cleanup', 'clean-' + member.ws.id, { workspace: member.ws.id })).toMatchObject({ removed: true });
    expect(await git(h.repo, 'worktree', 'list', '--porcelain')).not.toContain(mount);
    expect((await readFile('/proc/self/mountinfo', 'utf8')).includes(mount)).toBe(false);
    for (const left of [mount, `${mount}.state`, `${mount}.json`]) expect(await exists(left)).toBe(false);
  }, 60_000);

  it('keeps what the workspaces change where the host says', async () => {
    let states = '';
    const h = await fixture({ wsfsStateRoot: () => states });
    states = join(h.dir, 'states');
    const a = await h.member('a');
    const mount = a.ws.path.slice(0, a.ws.path.lastIndexOf('/')), state = join(states, h.state.workflowId, mount.slice(mount.lastIndexOf('/') + 1));
    await writeFile(join(a.ws.path, 'note.txt'), 'kept\n');
    expect(await readFile(join(state, 'ws', a.ws.id, 'upper', 'note.txt'), 'utf8')).toBe('kept\n');
    expect(await exists(`${mount}.state`)).toBe(false);
    // The place is recorded with the mount: told another one later, the service keeps the workspaces of the mount together.
    states = join(h.dir, 'elsewhere');
    const b = await h.member('b');
    await writeFile(join(b.ws.path, 'other.txt'), 'kept\n');
    expect(await readFile(join(state, 'ws', b.ws.id, 'upper', 'other.txt'), 'utf8')).toBe('kept\n');
    expect(await exists(join(h.dir, 'elsewhere'))).toBe(false);
    await rm(join(a.ws.path, 'note.txt')); await rm(join(b.ws.path, 'other.txt'));
    a.idle(); b.idle();
    for (const member of [a, b]) expect(await h.op('cleanup', 'clean-' + member.ws.id, { workspace: member.ws.id })).toMatchObject({ removed: true });
  }, 60_000);

  it('checks in a plain worktree where the host says, and the members stay wsfs workspaces', async () => {
    let trains = '';
    const h = await fixture({ trainRoot: () => trains });
    trains = join(h.dir, 'trains');
    const check = 'const fs=require("fs");if(!fs.existsSync("src/code.txt"))process.exit(1);fs.mkdirSync("build",{recursive:true});fs.writeFileSync("build/checked",process.cwd())';
    const landing = await h.op<WorkspaceLanding>('landing', 'landing', { checks: [{ argv: [process.execPath, '-e', check] }] });
    const a = await h.member('a'), b = await h.member('b');
    const mount = a.ws.path.slice(0, a.ws.path.lastIndexOf('/')), train = join(trains, h.state.workflowId, 'train-' + mount.slice(mount.lastIndexOf('-') + 1));
    await a.commit('a.txt', 'a\n');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    // The whole checkout is there as files of that directory, and the daemon has no workspace for the train.
    expect(await readFile(join(train, 'build/checked'), 'utf8')).toBe(await realpath(train));
    expect((await readFile(join(train, '.git'), 'utf8'))).toContain('/worktrees/train-');
    expect((await readFile('/proc/self/mountinfo', 'utf8')).includes(train)).toBe(false);
    expect(await exists(join(mount, `train-${h.state.workflowId}`))).toBe(false);
    expect(await exists(join(`${mount}.state`, 'ws', `train-${h.state.workflowId}`))).toBe(false);
    expect(a.ws.isolation).toBe('wsfs');
    // The directory is gone, as after the machine was replaced: the next train makes it again and lands as before.
    await rm(trains, { recursive: true });
    await b.commit('b.txt', 'b\n');
    expect(await b.land()).toMatchObject({ status: 'landed' });
    const head = await git(h.repo, 'rev-parse', landing.targetRef);
    expect(await git(train, 'rev-parse', 'HEAD')).toBe(head);
    expect((await git(h.repo, 'ls-tree', '-r', '--name-only', head)).split('\n').sort()).toEqual(['.gitignore', 'a.txt', 'b.txt', 'shared.txt', 'src/code.txt']);
    // Gone once more when the last member goes: the record of it in the repository goes all the same.
    await rm(trains, { recursive: true });
    a.idle(); b.idle();
    for (const member of [a, b]) expect(await h.op('cleanup', 'clean-' + member.ws.id, { workspace: member.ws.id })).toMatchObject({ removed: true });
    expect(await git(h.repo, 'worktree', 'list', '--porcelain')).not.toContain('/train-');
    expect((await readFile('/proc/self/mountinfo', 'utf8')).includes(mount)).toBe(false);
  }, 60_000);

  it('refuses a repository it cannot serve before anything is recorded', async () => {
    const h = await fixture();
    await git(h.repo, 'config', 'core.sparseCheckout', 'true');
    await expect(h.op('create', 'a', { isolation: 'wsfs' })).rejects.toThrow('sparse checkout');
    // The key is free for another isolation.
    await git(h.repo, 'config', '--unset', 'core.sparseCheckout');
    expect(await h.op<WorkspaceBinding>('create', 'a', {})).toMatchObject({ status: 'ready' });
    await expect(h.op('create', 'b', { isolation: 'overlay' })).rejects.toThrow('isolation is "worktree", "clone" or "wsfs"');
  }, 60_000);
});
