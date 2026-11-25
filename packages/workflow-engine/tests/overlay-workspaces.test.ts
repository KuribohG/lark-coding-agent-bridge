import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import { relocateIndex } from '../src/engine/workspace-overlay';
import { FSMONITOR_HOOK } from '../src/engine/workspace-overlay-hook';
import { workspaceCommand } from '../src/engine/workspace-process';
import { CLONE_REMOTE, WorkflowWorkspaces } from '../src/engine/workspaces';
import type { WorkspaceBinding, WorkspaceLanding } from '../src/engine/workspace-types';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, signal());
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const exists = (path: string) => access(path).then(() => true, () => false);
/** The entries of `git status --porcelain`, whose leading blanks carry meaning. */
const changes = async (cwd: string, ...options: string[]) => (await workspaceCommand('git', [...options, 'status', '--porcelain'], cwd, signal(), 60_000, { ...process.env, GIT_OPTIONAL_LOCKS: '0' })).stdout.split('\n').filter(Boolean).sort();
async function scratch(prefix: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
}

describe('the index an overlay workspace starts from', () => {
  it.skipIf(process.platform === 'win32')('keeps the untracked cache of the template when it is moved to another worktree', async () => {
    const dir = await scratch('workflow-overlay-index-');
    const one = join(dir, 'one'), two = join(dir, 'two');
    for (const repo of [one, two]) {
      await mkdir(join(repo, 'src'), { recursive: true });
      await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'A'); await git(repo, 'config', 'user.email', 'a@localhost');
      await git(repo, 'config', 'core.untrackedCache', 'true');
      await writeFile(join(repo, 'src/a.txt'), 'a\n'); await writeFile(join(repo, 'top.txt'), 'top\n');
      await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base', '--date', '2020-01-01T00:00:00Z');
    }
    await git(one, 'status');
    const template = await readFile(join(one, '.git/index'));
    expect(template.includes(Buffer.from(`Location ${one},`))).toBe(true);
    const moved = relocateIndex(template, two);
    expect(moved.includes(Buffer.from(`Location ${two},`))).toBe(true);
    expect(moved.includes(Buffer.from(`Location ${one},`))).toBe(false);
    // Git reads it, and does not find the cache to be another worktree's.
    await writeFile(join(two, '.git/index'), moved);
    const status = await workspaceCommand('git', ['status', '--porcelain'], two, signal());
    expect(status).toMatchObject({ code: 0, stdout: '' });
    expect(status.stderr).not.toContain('untracked cache is disabled');
    expect(await git(two, 'ls-files')).toBe('src/a.txt\ntop.txt');
  });

  it('returns an index it does not understand as it is', () => {
    for (const index of [Buffer.alloc(0), Buffer.from('not an index at all, but long enough to be looked at'), Buffer.concat([Buffer.from('DIRC'), Buffer.alloc(60)])]) {
      expect(relocateIndex(index, '/elsewhere')).toBe(index);
    }
  });
});

describe('the fsmonitor hook of an overlay workspace', () => {
  async function overlay() {
    const dir = await scratch('workflow-overlay-hook-');
    const at = join(dir, 'mount'), upper = join(dir, 'upper'), lower = join(dir, 'lower'), repo = join(dir, 'git'), hook = join(dir, 'hook.cjs');
    for (const made of [at, upper, join(lower, 'src'), repo]) await mkdir(made, { recursive: true });
    await writeFile(join(lower, 'file'), 'base'); await writeFile(hook, FSMONITOR_HOOK);
    await writeFile(join(at, '.git'), `gitdir: ${repo}\n`); await writeFile(join(upper, '.git'), `gitdir: ${repo}\n`);
    await writeFile(join(repo, 'bridge-overlay'), JSON.stringify({ upper, lower }));
    const ask = async (token: string, cwd = at) => {
      const result = await workspaceCommand(process.execPath, [hook, '2', token], cwd, signal());
      if (result.code) throw new Error(result.stderr);
      const [next, ...paths] = result.stdout.split('\0').slice(0, -1);
      return { token: next!, paths: paths.sort() };
    };
    return { dir, at, upper, lower, ask };
  }

  it('answers with what the upper directory holds, and names what a whiteout or a replaced file hides', async () => {
    const h = await overlay();
    expect(await h.ask('base')).toMatchObject({ paths: [] });
    await mkdir(join(h.upper, 'src/new'), { recursive: true });
    await writeFile(join(h.upper, 'src/edited.c'), ''); await writeFile(join(h.upper, 'src/new/added.c'), '');
    await writeFile(join(h.upper, 'src/.wh.deleted.c'), ''); await writeFile(join(h.upper, 'src/new/.wh..wh..opq'), '');
    // The base has a file where the workspace now has a directory.
    await mkdir(join(h.upper, 'file')); await writeFile(join(h.upper, 'file/inside'), '');
    expect((await h.ask('base')).paths).toEqual(['file', 'file/inside', 'src/deleted.c', 'src/deleted.c/', 'src/edited.c', 'src/new/', 'src/new/added.c']);
    // The base tree has no upper directory: nothing differs from it.
    expect(await h.ask('base', h.lower)).toEqual({ token: 'base', paths: [] });
  });

  it('reports a file that was only in the upper directory once it is gone from there', async () => {
    const h = await overlay();
    await writeFile(join(h.upper, 'kept'), ''); await writeFile(join(h.upper, 'mine'), '');
    const first = await h.ask('base');
    expect(first.paths).toEqual(['kept', 'mine']);
    await unlink(join(h.upper, 'mine'));
    const second = await h.ask(first.token);
    expect(second.paths).toEqual(['kept', 'mine']);
    expect(second.token).not.toBe(first.token);
    // Git has seen the deletion once it holds the newer token.
    expect((await h.ask(second.token)).paths).toEqual(['kept']);
  });

  it('tells Git to trust nothing when it is asked about a listing it does not have', async () => {
    const h = await overlay();
    await writeFile(join(h.upper, 'kept'), '');
    expect((await h.ask('0'.repeat(40))).paths).toEqual(['/', 'kept']);
    expect((await h.ask('../../etc/passwd')).paths).toEqual(['/', 'kept']);
  });
});

/** Whether this host mounts an overlay at all, tried once: a runner may have fuse-overlayfs and still not let it mount. */
function mounts(): boolean {
  if (process.platform !== 'linux' || !existsSync('/dev/fuse')) return false;
  const dir = mkdtempSync(join(tmpdir(), 'workflow-overlay-try-'));
  try {
    for (const name of ['lower', 'upper', 'work', 'merged']) mkdirSync(join(dir, name));
    const mounted = spawnSync(process.env.WORKFLOW_OVERLAY_COMMAND || 'fuse-overlayfs',
      ['-o', `lowerdir=${join(dir, 'lower')},upperdir=${join(dir, 'upper')},workdir=${join(dir, 'work')}`, join(dir, 'merged')], { stdio: 'ignore' }).status === 0;
    return mounted && spawnSync('fusermount3', ['-u', join(dir, 'merged')], { stdio: 'ignore' }).status === 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const mountable = mounts();

async function fixture() {
  const dir = await scratch('workflow-overlay-');
  const repo = join(dir, 'repo'); await mkdir(join(repo, 'src/deep'), { recursive: true });
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Source Author'); await git(repo, 'config', 'user.email', 'source@localhost');
  await writeFile(join(repo, 'shared.txt'), 'baseline\n'); await writeFile(join(repo, 'src/deep/a.txt'), 'a\n'); await writeFile(join(repo, 'src/b.txt'), 'b\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const base = await git(repo, 'rev-parse', 'HEAD');
  const root = { scopeId: 'scope', profile: 'test', agentKind: 'codex' as const, cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'root', modelSettings: {} };
  const kernel = new WorkflowKernel(':memory:', { resolveRoot: async () => root, execute: async () => ({ status: 'completed' }), wakeMain: async () => {} });
  closes.push(() => kernel.close());
  await kernel.call({ kind: 'main', scopeId: 'scope', allowStart: true }, 'run_script', { operationId: 'start', goal: 'test', plan: 'test overlays', script: 'return null;' });
  const state = kernel.state('scope')!;
  const worktrees = join(dir, 'worktrees');
  const manager = new WorkflowWorkspaces(join(dir, 'workspaces.sqlite'), worktrees);
  closes.push(() => manager.close());
  const ctx = { state, signal: signal() };
  const op = <T>(kind: string, key: string, args: object = {}) => manager.perform(ctx, { kind, key, ...args }) as Promise<T>;
  const unmount = (path: string) => workspaceCommand('fusermount3', ['-u', '-z', path], dir, signal());
  // Whatever a failed test left mounted is let go before its directory is deleted.
  closes.push(async () => { for (const name of await readdir(join(worktrees, state.workflowId)).catch(() => [])) await unmount(join(worktrees, state.workflowId, name)).catch(() => undefined); });
  const member = async (name: string, isolation: 'overlay' | undefined = 'overlay') => {
    const ws = await op<WorkspaceBinding>('create', name, isolation ? { isolation } : {});
    const token = manager.begin(ws, name);
    return { ws, land: () => manager.land(ctx, { workspace: ws.id, taskId: name }), idle: () => manager.end(ws, token),
      commit: async (file: string, content: string) => { await writeFile(join(ws.path, file), content); await git(ws.path, 'add', '.'); await git(ws.path, 'commit', '-m', file); return git(ws.path, 'rev-parse', 'HEAD'); } };
  };
  const configure = () => op<WorkspaceLanding>('landing', 'landing-' + randomUUID(), { checks: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] });
  const store = (ws: WorkspaceBinding) => join(worktrees, 'overlay', ws.workflowId, ws.id);
  return { dir, repo, base, state, manager, ctx, op, member, configure, unmount, worktrees, store };
}

describe.skipIf(!mountable)('overlay workspaces', () => {
  it('shows the whole baseline to each member and stores only what the member changes', async () => {
    const h = await fixture();
    const a = await h.member('a'), b = await h.member('b');
    expect(a.ws).toMatchObject({ isolation: 'overlay', baseCommit: h.base, status: 'ready' });
    // The repository is beside the mount; the mount shows the file that names it.
    expect((await stat(join(a.ws.path, '.git'))).isFile()).toBe(true);
    expect(await git(a.ws.path, 'rev-parse', '--absolute-git-dir')).toBe(join(h.store(a.ws), 'git'));
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(a.ws.path, 'src/deep/a.txt'), 'utf8')).toBe('a\n');
    expect(await git(a.ws.path, 'remote', 'get-url', CLONE_REMOTE)).toBe(a.ws.repository);
    expect(await git(a.ws.path, 'config', 'user.email')).toBe('source@localhost');
    // No file of the checkout was written for either member: both read one tree.
    expect(await readdir(join(h.store(a.ws), 'upper'))).toEqual(['.git']);
    expect((await readdir(join(h.worktrees, 'overlay/bases'))).filter(name => name.endsWith(h.base))).toHaveLength(1);

    await writeFile(join(a.ws.path, 'src/b.txt'), 'changed by a\n'); await unlink(join(a.ws.path, 'shared.txt'));
    await mkdir(join(a.ws.path, 'fresh')); await writeFile(join(a.ws.path, 'fresh/new.txt'), 'new\n');
    expect(await changes(a.ws.path)).toEqual([' D shared.txt', ' M src/b.txt', '?? fresh/']);
    // The other member and the source see none of it.
    expect(await readFile(join(b.ws.path, 'src/b.txt'), 'utf8')).toBe('b\n');
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(h.repo, 'shared.txt'), 'utf8')).toBe('baseline\n');
    // Git's quick answer is the one a full look at every file gives.
    expect(await changes(a.ws.path, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false')).toEqual([' D shared.txt', ' M src/b.txt', '?? fresh/']);
    await expect(h.manager.clean(a.ws, signal())).rejects.toThrow('uncommitted or untracked changes');
    a.idle(); b.idle();
  });

  it('lands an overlay member\'s commits on the source\'s landing branch', async () => {
    const h = await fixture();
    const { targetRef } = await h.configure();
    const a = await h.member('a'), b = await h.member('b');
    const first = await a.commit('a.txt', 'from a\n');
    expect(await a.land()).toMatchObject({ status: 'landed', headCommit: first, commits: 1 });
    await b.commit('b.txt', 'from b\n');
    const landed = await b.land();
    expect(landed).toMatchObject({ status: 'landed', commits: 1 });
    expect(await git(h.repo, 'rev-parse', targetRef)).toBe((landed as { headCommit: string }).headCommit);
    // The landing rebased b onto a's work, and b's workspace shows it.
    expect(await readFile(join(b.ws.path, 'a.txt'), 'utf8')).toBe('from a\n');
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
    a.idle(); b.idle();
  });

  it('mounts a workspace again when its mount was lost, with the member\'s work as it was', async () => {
    const h = await fixture();
    const a = await h.member('a');
    await a.commit('kept.txt', 'committed\n');
    await writeFile(join(a.ws.path, 'src/b.txt'), 'uncommitted\n');
    expect((await h.unmount(a.ws.path)).code).toBe(0);
    expect(await exists(join(a.ws.path, 'shared.txt'))).toBe(false);
    await h.manager.binding(h.state.root, h.state.workflowId, a.ws.id, signal());
    expect(await readFile(join(a.ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    expect(await readFile(join(a.ws.path, 'kept.txt'), 'utf8')).toBe('committed\n');
    expect(await changes(a.ws.path)).toEqual([' M src/b.txt']);
    a.idle();
  });

  it('mounts a workspace again when the process that served it died', async () => {
    const h = await fixture();
    const a = await h.member('a');
    await writeFile(join(a.ws.path, 'src/b.txt'), 'uncommitted\n');
    // The kernel still answers a stat of the directory from its cache; only reading shows the mount is dead.
    const served = await workspaceCommand('pgrep', ['-f', `upperdir=${join(h.store(a.ws), 'upper')},`], h.dir, signal());
    process.kill(Number(served.stdout.trim().split('\n')[0]), 'SIGKILL');
    await expect.poll(() => readFile(join(a.ws.path, 'shared.txt'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code)).toBe('ENOTCONN');
    await h.manager.binding(h.state.root, h.state.workflowId, a.ws.id, signal());
    expect(await readFile(join(a.ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    expect(await changes(a.ws.path)).toEqual([' M src/b.txt']);
    a.idle();
  });

  it('unmounts and deletes a removed workspace, and the baseline checkout with the last one', async () => {
    const h = await fixture();
    const a = await h.member('a'), b = await h.member('b');
    await a.commit('a.txt', 'unlanded\n');
    a.idle(); b.idle();
    const bases = async () => (await readdir(join(h.worktrees, 'overlay/bases'))).filter(name => name.endsWith(h.base));
    expect(await h.op('cleanup', 'drop-a', { workspace: a.ws.id })).toEqual({ workspace: a.ws.id, removed: true });
    expect(await exists(a.ws.path)).toBe(false);
    expect(await exists(h.store(a.ws))).toBe(false);
    expect(await readFile('/proc/self/mountinfo', 'utf8')).not.toContain(a.ws.id);
    expect(await git(h.repo, 'for-each-ref', `refs/bridge-workflow/${h.state.workflowId}/clones/${a.ws.id}`)).toBe('');
    // b still reads the baseline checkout.
    expect(await bases()).toHaveLength(1);
    expect(await readFile(join(b.ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    await h.op('cleanup', 'drop-b', { workspace: b.ws.id });
    await expect.poll(bases).toHaveLength(0);
    await expect(h.op('create', 'again', { isolation: 'overlay' })).resolves.toMatchObject({ status: 'ready' });
  });

  it('freezes an overlay member\'s change for an independent review snapshot', async () => {
    const h = await fixture();
    const a = await h.member('a');
    await a.commit('src/b.txt', 'reviewed\n');
    a.idle();
    const change = await h.op<{ id: string }>('freeze', 'freeze-a', { workspace: a.ws.id });
    // A review snapshot is a plain worktree; it reads what the overlay member froze.
    const review = await h.op<WorkspaceBinding>('create', 'review-a', { change: change.id });
    expect(await readFile(join(review.path, 'src/b.txt'), 'utf8')).toBe('reviewed\n');
  });
});

describe('the overlay isolation option', () => {
  it('is refused with the reason where no overlay can be mounted', async () => {
    const h = await fixture();
    const kept = process.env.WORKFLOW_OVERLAY_COMMAND;
    process.env.WORKFLOW_OVERLAY_COMMAND = join(h.dir, 'no-such-command');
    try {
      await expect(h.op('create', 'a', { isolation: 'overlay' })).rejects.toThrow('Overlay workspaces are unavailable here');
      // Nothing was recorded: the same key takes another isolation.
      await expect(h.op('create', 'a', { isolation: 'clone' })).resolves.toMatchObject({ isolation: 'clone', status: 'ready' });
    } finally { if (kept === undefined) delete process.env.WORKFLOW_OVERLAY_COMMAND; else process.env.WORKFLOW_OVERLAY_COMMAND = kept; }
  });
});
