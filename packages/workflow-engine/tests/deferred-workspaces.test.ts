import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import { workspaceCommand } from '../src/engine/workspace-process';
import { WorkflowWorkspaces } from '../src/engine/workspaces';
import type { WorkspaceBinding } from '../src/engine/workspace-types';
import { gate, writes } from './helpers/held-git';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); }, 30_000);
const signal = () => new AbortController().signal;
const exists = (path: string) => access(path).then(() => true, () => false);
async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, signal());
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-deferred-'));
  closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'shared.txt'), 'baseline\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const base = await git(repo, 'rev-parse', 'HEAD');
  const root = { scopeId: 'scope', profile: 'test', agentKind: 'codex' as const, cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'root', modelSettings: {} };
  const kernel = new WorkflowKernel(':memory:', { resolveRoot: async () => root, execute: async () => ({ status: 'completed' }), wakeMain: async () => {} });
  closes.push(() => kernel.close());
  await kernel.call({ kind: 'main', scopeId: 'scope', allowStart: true }, 'run_script', { operationId: 'start', goal: 'test', plan: 'test deferred worktrees', script: 'return null;' });
  const state = kernel.state('scope')!;
  const held = gate(dir);
  const path = join(dir, 'workspaces.sqlite');
  let manager = new WorkflowWorkspaces(path, join(dir, 'worktrees'), held.processes);
  closes.push(() => manager.close());
  const op = <T>(kind: string, key: string, args: object = {}) => manager.perform({ state, signal: signal() }, { kind, key, ...args }) as Promise<T>;
  return { dir, repo, base, root, state, held, op, get manager() { return manager; }, workflow: state.workflowId,
    standing: (ws: WorkspaceBinding, allowed?: () => Promise<void>) => manager.standing(root, state.workflowId, ws.id, allowed),
    restart: async () => { await manager.close(); manager = new WorkflowWorkspaces(path, join(dir, 'worktrees'), held.processes); } };
}

describe('worktrees whose files are written after their creation has answered', () => {
  it('answers with a worktree that is being prepared, says how it stands, and gives the same one to whoever asks again', async () => {
    const h = await fixture(); h.held.hold(writes);
    const ws = await h.op<WorkspaceBinding>('create', 'a', { wait: false });
    expect(ws).toMatchObject({ status: 'preparing', baseCommit: h.base });
    expect(h.standing(ws)).toBe('preparing');
    expect(h.manager.preparing(h.root, h.workflow, ws.id)).toBe(true);
    await expect(h.manager.binding(h.root, h.workflow, ws.id, signal())).rejects.toThrow('still being prepared');
    // Freezing it waits for its files, as does asking for it again without `wait: false`.
    let frozen = false;
    const early = h.op<{ headCommit: string }>('freeze', 'early', { workspace: ws.id }); void early.then(() => { frozen = true; }, () => {});
    expect(await h.op('create', 'a', { wait: false })).toMatchObject({ id: ws.id, status: 'preparing' });
    let told = 0; h.manager.watch(() => { told++; });
    const waited = h.op<WorkspaceBinding>('create', 'a'), prepared = h.manager.prepared(h.root, h.workflow, ws.id, signal());
    await new Promise(done => setTimeout(done, 200));
    expect(frozen).toBe(false);
    await h.held.release();
    expect(await waited).toMatchObject({ id: ws.id, status: 'ready' });
    expect((await early).headCommit).toBe(h.base);
    expect((await prepared).id).toBe(ws.id);
    expect(h.standing(ws)).toBe('ready');
    await vi.waitFor(() => expect(told).toBe(1));
    expect(await readFile(join(ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    expect(await git(ws.path, 'status', '--porcelain')).toBe('');
    // Once made it is what the key stands for, however it is asked for.
    expect(await h.op('create', 'a', { wait: false })).toMatchObject({ id: ws.id, status: 'ready' });
    await expect(h.op('create', 'b', { wait: 'no' })).rejects.toThrow('wait is true or false');
    await expect(h.op('freeze', 'f', { workspace: ws.id, wait: false })).rejects.toThrow('only a creation takes it');
  }, 30_000);

  it('records a worktree nobody waited for as made, so a later service finds it ready', async () => {
    const h = await fixture();
    const ws = await h.op<WorkspaceBinding>('create', 'a', { wait: false });
    await vi.waitFor(() => expect(h.standing(ws)).toBe('ready'));
    await h.restart();
    expect(h.standing(ws)).toBe('ready');
    expect(await h.op('create', 'a')).toMatchObject({ id: ws.id, status: 'ready' });
  }, 30_000);

  it('tells a failure once, to whoever is bound to the worktree, and writes the files again when asked after that', async () => {
    const h = await fixture(); let full = true;
    h.held.fail(args => full && args.includes('read-tree'));
    const ws = await h.op<WorkspaceBinding>('create', 'a', { wait: false });
    await vi.waitFor(() => expect(h.standing(ws)).toEqual({ failed: expect.stringContaining('no space left on device') }));
    full = false;
    expect(h.standing(ws)).toBe('preparing');
    await vi.waitFor(() => expect(h.standing(ws)).toBe('ready'));
    expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    // A caller that waits for the worktree is told the same way.
    full = true;
    const other = await h.op<WorkspaceBinding>('create', 'b', { wait: false });
    await expect(h.manager.prepared(h.root, h.workflow, other.id, signal())).rejects.toThrow('could not be prepared: Git read-tree failed');
  }, 30_000);

  it('writes the files again after a restart, once the host allows it', async () => {
    const h = await fixture(); h.held.hold(writes);
    const ws = await h.op<WorkspaceBinding>('create', 'a', { wait: false });
    await vi.waitFor(async () => expect(await exists(join(ws.path, '.git'))).toBe(true));
    await h.restart();
    const refused = vi.fn(async () => { throw new Error('root authorization changed'); });
    expect(h.standing(ws, refused)).toBe('preparing');
    await vi.waitFor(() => expect(h.standing(ws, async () => {})).not.toBe('preparing'), { timeout: 5000 });
    expect(refused).toHaveBeenCalledTimes(1);
    // That look told the refusal; the next one starts again, and this time the files may be written.
    expect(h.standing(ws, async () => {})).toBe('preparing');
    await h.held.release();
    await vi.waitFor(() => expect(h.standing(ws)).toBe('ready'));
    expect(await readFile(join(ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    expect(h.standing(ws, refused)).toBe('ready');
    expect(h.manager.standing({ ...h.root, policyFingerprint: 'changed' }, h.workflow, ws.id)).toBe('ready');
    expect(h.manager.standing(h.root, h.workflow, randomUUID())).toEqual({ failed: 'Unknown workspace' });
  }, 30_000);

  it.each(['pointing at no commit', 'missing'] as const)('registers a worktree again when its registration was stopped with HEAD %s', async left => {
    const h = await fixture(); h.held.hold(writes);
    const ws = await h.op<WorkspaceBinding>('create', 'a', { wait: false });
    // Held at its files, the worktree is registered in full. `worktree add` writes the `.git` file first and the commit
    // HEAD is at last, so one that is stopped in between leaves what is put here in place of the finished registration.
    await vi.waitFor(() => expect(h.held.ran.some(args => args.includes('read-tree'))).toBe(true));
    await h.restart();
    const admin = await git(ws.path, 'rev-parse', '--absolute-git-dir');
    if (left === 'missing') await rm(join(admin, 'HEAD')); else await writeFile(join(admin, 'HEAD'), '0'.repeat(40) + '\n');
    await h.held.release();
    expect(h.standing(ws)).toBe('preparing');
    await vi.waitFor(() => expect(h.standing(ws)).toBe('ready'), { timeout: 10_000 });
    expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(await readFile(join(ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    expect(await git(ws.path, 'status', '--porcelain')).toBe('');
    // Registered once, and locked as any worktree of the service is.
    const listed = (await git(h.repo, 'worktree', 'list', '--porcelain')).split('\n\n').filter(entry => entry.includes(ws.id));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain(`locked bridge-workflow:${ws.id}`);
  }, 30_000);

  it('gives the next turn to a worktree somebody waits for, then to those it is told are wanted, then to the others', async () => {
    const h = await fixture();
    // A repository's worktrees are registered one at a time: while the first registration is held, the others wait their turn.
    const adds = () => h.held.ran.filter(args => args.includes('worktree') && args.includes('add'));
    let held: readonly string[] | undefined;
    h.held.hold(args => args.includes('worktree') && args.includes('add') && (held ??= args) === args);
    const made = [await h.op<WorkspaceBinding>('create', 'a', { wait: false })];
    await vi.waitFor(() => expect(adds()).toHaveLength(1));
    for (const key of ['b', 'c', 'd', 'e']) made.push(await h.op<WorkspaceBinding>('create', key, { wait: false }));
    await new Promise(done => setTimeout(done, 300));
    const [a, b, c, d, e] = made as [WorkspaceBinding, WorkspaceBinding, WorkspaceBinding, WorkspaceBinding, WorkspaceBinding];
    h.manager.want(h.workflow, [d.id, c.id]);
    const waited = h.manager.prepared(h.root, h.workflow, e.id, signal());
    await h.held.release();
    expect((await waited).id).toBe(e.id);
    await vi.waitFor(() => expect(adds()).toHaveLength(5), { timeout: 10_000 });
    expect(adds().map(args => made.find(ws => args.includes(ws.path))!.id)).toEqual([a, e, d, c, b].map(ws => ws.id));
    await vi.waitFor(() => expect(made.map(ws => h.standing(ws))).toEqual(made.map(() => 'ready')), { timeout: 10_000 });
    // What a workflow wants is replaced by what it says next, and forgotten with the workflow.
    h.manager.want(h.workflow, []);
    h.manager.abandon(() => new Set());
  }, 30_000);

  it.each(['worktree', 'clone'] as const)('cleans up a %s that is still being prepared, stopping whoever writes it', async isolation => {
    const h = await fixture(); h.held.hold(writes);
    const ws = await h.op<WorkspaceBinding>('create', 'a', { wait: false, ...(isolation === 'clone' ? { isolation } : {}) });
    await vi.waitFor(async () => expect(await exists(join(ws.path, '.git'))).toBe(true));
    expect(await h.op('cleanup', 'clean', { workspace: ws.id })).toEqual({ workspace: ws.id, removed: true });
    expect(await exists(ws.path)).toBe(false);
    expect(await git(h.repo, 'worktree', 'list', '--porcelain')).not.toContain(ws.path);
    expect(await git(h.repo, 'for-each-ref', 'refs/bridge-workflow')).toBe('');
    expect(h.standing(ws)).toEqual({ failed: 'Workspace was removed' });
    // Let go now, the held command finds nothing to write into: nothing comes back.
    await h.held.release();
    await new Promise(done => setTimeout(done, 200));
    expect(await exists(ws.path)).toBe(false);
    await expect(h.op('create', 'a', { wait: false, ...(isolation === 'clone' ? { isolation } : {}) })).rejects.toThrow('removed');
  }, 30_000);

  it('stops writing for a workflow that has ended and leaves the others alone', async () => {
    const h = await fixture(); h.held.hold(writes);
    const ws = await h.op<WorkspaceBinding>('create', 'a', { wait: false });
    let told = 0; h.manager.watch(() => { told++; });
    const kept = vi.fn(() => new Set([h.workflow]));
    h.manager.abandon(kept);
    expect(kept).toHaveBeenCalledTimes(1);
    await new Promise(done => setTimeout(done, 100));
    expect(told).toBe(0);
    h.manager.abandon(() => new Set());
    await vi.waitFor(() => expect(told).toBe(1));
    // Given up is not failed: asked for again, the files are written.
    expect(h.standing(ws)).toBe('preparing');
    await h.held.release();
    await vi.waitFor(() => expect(h.standing(ws)).toBe('ready'));
    // Nothing is being written now, so nobody is asked which workflows still run.
    h.manager.abandon(kept);
    expect(kept).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe('a large checkout written by several Git processes', () => {
  const run = (cwd: string, args: string[], env = process.env, input?: string) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: 256 << 20 });
  /** Files enough for a large checkout, under names short enough for a filesystem that bounds the length of a path. */
  const MANY = Array.from({ length: 6000 }, (_, index) => `bulk/${index % 48}/f-${index}.txt`);
  /** A commit with MANY, attributes that change line endings, an executable and a symlink. */
  function varied(repo: string, parent: string, dir: string, attributes = true): string {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index-' + randomUUID()) };
    const blob = (text: string) => run(repo, ['hash-object', '-w', '--stdin'], process.env, text).trim();
    const shared = blob('x\n');
    run(repo, ['read-tree', parent], env);
    run(repo, ['update-index', '--add', '--index-info'], env, [...MANY.map(path => `100644 ${shared}\t${path}`),
      ...(attributes ? [`100644 ${blob('*.crlf text eol=crlf\n')}\t.gitattributes`] : []), `100644 ${blob('one\ntwo\n')}\tzz/last.crlf`, `100644 ${blob('')}\taa/empty.txt`,
      `100755 ${blob('#!/bin/sh\necho ok\n')}\ttools/run.sh`, `120000 ${blob('run.sh')}\ttools/link`].join('\n') + '\n');
    return run(repo, ['commit-tree', run(repo, ['write-tree'], env).trim(), '-p', parent, '-m', 'varied']).trim();
  }

  it.each(['worktree', 'clone'] as const)('makes a %s whose files and index are what Git alone would have left', async isolation => {
    const h = await fixture(); const commit = varied(h.repo, h.base, h.dir);
    const ws = await h.op<WorkspaceBinding>('create', 'big', { base: commit, ...(isolation === 'clone' ? { isolation } : {}) });
    // Several processes wrote it, each a stretch of the files, and none of them the whole checkout.
    expect(h.held.ran.filter(args => args.includes('checkout-index')).length).toBeGreaterThan(8);
    expect(h.held.ran.some(args => args.includes('read-tree') && args.includes('-u'))).toBe(false);
    expect(run(ws.path, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(run(ws.path, ['rev-parse', 'HEAD']).trim()).toBe(commit);
    expect(run(ws.path, ['ls-files', '-s'])).toBe(run(h.repo, ['ls-tree', '-r', commit]).replace(/^(\d+) blob (\w+)\t/gm, '$1 $2 0\t'));
    // What each process recorded of its files is in the one index: no file is read again to tell that it is unchanged.
    const recorded = run(ws.path, ['ls-files', '--debug']);
    expect(recorded.match(/^ {2}mtime: 0:0$/gm)).toBeNull();
    expect(recorded.match(/^ {2}size: 0\t/gm)).toHaveLength(1);
    // A clone does not take the source's core.autocrlf, so Git for Windows writes its files with CRLF.
    const crlf = isolation === 'clone' && process.platform === 'win32';
    expect(recorded.match(crlf ? /^ {2}size: 3\t/gm : /^ {2}size: 2\t/gm)!.length).toBeGreaterThanOrEqual(MANY.length);
    // Attributes come from the commit, whichever process writes the `.gitattributes` file and when.
    expect(await readFile(join(ws.path, 'zz/last.crlf'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect(await readFile(join(ws.path, MANY.at(-1)!), 'utf8')).toBe(crlf ? 'x\r\n' : 'x\n');
    if (process.platform !== 'win32') {
      expect((await lstat(join(ws.path, 'tools/run.sh'))).mode & 0o111).toBe(0o111);
      expect(await readlink(join(ws.path, 'tools/link'))).toBe('run.sh');
    }
    // The index is one a member commits from: only what it changed is in the commit.
    await writeFile(join(ws.path, 'aa/empty.txt'), 'no longer\n');
    run(ws.path, ['-c', 'user.name=Member', '-c', 'user.email=member@localhost', 'commit', '-qam', 'change']);
    expect(run(ws.path, ['diff', '--name-only', 'HEAD~1', 'HEAD']).trim()).toBe('aa/empty.txt');
    expect(run(ws.path, ['rev-parse', 'HEAD~1^{tree}'])).toBe(run(h.repo, ['rev-parse', `${commit}^{tree}`]));
    expect(run(ws.path, ['status', '--porcelain'])).toBe('');
  }, 120_000);

  it('leaves a checkout with attributes to Git alone when Git cannot read them from the commit', async () => {
    const h = await fixture(); const commit = varied(h.repo, h.base, h.dir);
    h.held.fail(args => args.some(arg => arg.startsWith('--attr-source=')));
    const ws = await h.op<WorkspaceBinding>('create', 'big', { base: commit });
    expect(h.held.ran.some(args => args.includes('checkout-index'))).toBe(false);
    expect(h.held.ran.some(args => args.includes('read-tree') && args.includes('-u'))).toBe(true);
    expect(await readFile(join(ws.path, 'zz/last.crlf'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect(run(ws.path, ['status', '--porcelain'])).toBe('');
    // Without attributes anywhere in the commit there is nothing such a Git would get wrong.
    const plain = varied(h.repo, h.base, h.dir, false);
    const other = await h.op<WorkspaceBinding>('create', 'plain', { base: plain });
    expect(h.held.ran.filter(args => args.includes('checkout-index')).length).toBeGreaterThan(8);
    expect(await readFile(join(other.path, 'zz/last.crlf'), 'utf8')).toBe('one\ntwo\n');
    expect(run(other.path, ['status', '--porcelain'])).toBe('');
  }, 120_000);

  it('leaves a sparse checkout to Git alone, which writes only the files its patterns keep', async () => {
    const h = await fixture(); const commit = varied(h.repo, h.base, h.dir);
    run(h.repo, ['sparse-checkout', 'set', '--no-cone', '/*', '!/zz/']);
    const ws = await h.op<WorkspaceBinding>('create', 'big', { base: commit });
    expect(h.held.ran.some(args => args.includes('checkout-index'))).toBe(false);
    expect(await exists(join(ws.path, 'aa/empty.txt'))).toBe(true);
    expect(await exists(join(ws.path, 'zz/last.crlf'))).toBe(false);
    expect(run(ws.path, ['ls-files', '-t', 'zz/last.crlf', 'aa/empty.txt'])).toBe('H aa/empty.txt\nS zz/last.crlf\n');
    expect(run(ws.path, ['status', '--porcelain'])).toBe('');
  }, 120_000);

  it('fails the creation when a process cannot write its stretch, and writes the whole checkout when asked again', async () => {
    const h = await fixture(); const commit = varied(h.repo, h.base, h.dir);
    let full = true, seen = 0;
    h.held.fail(args => full && args.includes('checkout-index') && ++seen === 5);
    await expect(h.op('create', 'big', { base: commit })).rejects.toThrow('no space left on device');
    full = false;
    const ws = await h.op<WorkspaceBinding>('create', 'big', { base: commit });
    expect(run(ws.path, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(run(ws.path, ['ls-files']).split('\n').filter(Boolean)).toHaveLength(MANY.length + 6);
  }, 120_000);
});
