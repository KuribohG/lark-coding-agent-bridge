import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowKernel } from '../src/engine/kernel';
import { workspaceCommand } from '../src/engine/workspace-process';
import { CLONE_REMOTE, WorkflowWorkspaces } from '../src/engine/workspaces';
import type { WorkspaceBinding, WorkspaceChange, WorkspaceLanding } from '../src/engine/workspace-types';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, signal());
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const exists = (path: string) => access(path).then(() => true, () => false);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-clone-'));
  closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Source Author'); await git(repo, 'config', 'user.email', 'source@localhost');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'shared.txt'), 'baseline\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const base = await git(repo, 'rev-parse', 'HEAD');
  const root = { scopeId: 'scope', profile: 'test', agentKind: 'codex' as const, cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'root', modelSettings: {} };
  const kernel = new WorkflowKernel(':memory:', { resolveRoot: async () => root, execute: async () => ({ status: 'completed' }), wakeMain: async () => {} });
  closes.push(() => kernel.close());
  await kernel.call({ kind: 'main', scopeId: 'scope', allowStart: true }, 'run_script', { operationId: 'start', goal: 'test', plan: 'test clones', script: 'return null;' });
  const state = kernel.state('scope')!;
  const manager = new WorkflowWorkspaces(join(dir, 'workspaces.sqlite'), join(dir, 'worktrees'));
  closes.push(() => manager.close());
  const ctx = { state, signal: signal() };
  const op = <T>(kind: string, key: string, args: object = {}) => manager.perform(ctx, { kind, key, ...args }) as Promise<T>;
  /** A member's workspace with a turn running in it. */
  const member = async (name: string, isolation?: 'clone') => {
    const ws = await op<WorkspaceBinding>('create', name, isolation ? { isolation } : {});
    const token = manager.begin(ws, name);
    return { ws, land: () => manager.land(ctx, { workspace: ws.id, taskId: name }), idle: () => manager.end(ws, token),
      commit: async (file: string, content: string) => { await writeFile(join(ws.path, file), content); await git(ws.path, 'add', '.'); await git(ws.path, 'commit', '-m', file); return git(ws.path, 'rev-parse', 'HEAD'); } };
  };
  const configure = () => op<WorkspaceLanding>('landing', 'landing-' + randomUUID(), { checks: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] });
  return { dir, repo, base, state, manager, ctx, op, member, configure };
}

describe('clone workspaces', () => {
  it('gives each member a repository that shares no refs, stash or index with the source or another member', async () => {
    const h = await fixture();
    // The source has a remote of its own and a branch the member may want to look at.
    await git(h.repo, 'remote', 'add', 'origin', 'https://example.invalid/project.git');
    await git(h.repo, 'update-ref', 'refs/remotes/origin/main', h.base);
    const a = await h.member('a', 'clone'), b = await h.member('b', 'clone');
    expect(a.ws).toMatchObject({ isolation: 'clone', baseCommit: h.base, status: 'ready' });
    expect((await stat(join(a.ws.path, '.git'))).isDirectory()).toBe(true);
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    expect(await git(a.ws.path, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(a.ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    // History is borrowed, not copied.
    expect(await readFile(join(a.ws.path, '.git/objects/info/alternates'), 'utf8')).toContain(join('.git', 'objects'));
    // The source is a remote, its own remote and remote-tracking refs come along, and commits keep the author.
    expect(await git(a.ws.path, 'remote', 'get-url', CLONE_REMOTE)).toBe(a.ws.repository);
    expect(await git(a.ws.path, 'remote', 'get-url', 'origin')).toBe('https://example.invalid/project.git');
    expect(await git(a.ws.path, 'rev-parse', 'origin/main')).toBe(h.base);
    expect(await git(a.ws.path, 'rev-parse', `${CLONE_REMOTE}/main`)).toBe(h.base);
    expect(await git(a.ws.path, 'config', 'user.email')).toBe('source@localhost');

    await writeFile(join(a.ws.path, 'shared.txt'), 'in progress\n');
    await git(a.ws.path, 'stash'); await git(a.ws.path, 'branch', 'mine');
    expect(await git(a.ws.path, 'stash', 'list')).toContain('stash@{0}');
    for (const other of [b.ws.path, h.repo]) {
      expect(await git(other, 'stash', 'list')).toBe('');
      expect(await git(other, 'branch', '--list', 'mine')).toBe('');
    }
    // Nothing of the clone is registered in the source, unlike a worktree.
    expect(await git(h.repo, 'worktree', 'list', '--porcelain')).not.toContain(a.ws.path);
    // Repeating the operation answers from the record.
    expect(await h.op<WorkspaceBinding>('create', 'a', { isolation: 'clone' })).toMatchObject({ id: a.ws.id, path: a.ws.path });
  }, 60_000);

  it('lands a clone\'s commits on the source\'s landing branch alongside a worktree member\'s', async () => {
    const h = await fixture(); const landing = await h.configure();
    const a = await h.member('a', 'clone'), b = await h.member('b');
    const first = await a.commit('a.txt', 'a\n');
    // The commit exists only in the clone until it is submitted.
    await expect(git(h.repo, 'cat-file', '-e', first)).rejects.toThrow();
    expect(await a.land()).toMatchObject({ status: 'landed', commits: 1, headCommit: first });
    expect(await git(h.repo, 'rev-parse', landing.targetRef)).toBe(first);
    await b.commit('b.txt', 'b\n');
    const second = await b.land() as { status: string; headCommit: string };
    expect(second).toMatchObject({ status: 'landed', commits: 1 });
    // The clone reads what others landed without fetching, rebases onto it and is moved to the new head.
    await a.commit('a2.txt', 'a2\n');
    const third = await a.land() as { status: string; headCommit: string };
    expect(third).toMatchObject({ status: 'landed', commits: 1 });
    expect(await git(h.repo, 'rev-parse', landing.targetRef)).toBe(third.headCommit);
    expect(await git(a.ws.path, 'rev-parse', 'HEAD')).toBe(third.headCommit);
    expect((await git(h.repo, 'ls-tree', '--name-only', landing.targetRef)).split('\n').sort()).toEqual(['a.txt', 'a2.txt', 'b.txt', 'shared.txt']);
    await git(a.ws.path, 'fetch', '--quiet', CLONE_REMOTE);
    expect(await git(a.ws.path, 'rev-parse', `${CLONE_REMOTE}/${landing.targetRef.replace('refs/heads/', '')}`)).toBe(third.headCommit);
  }, 60_000);

  it('reports a conflict with landed work and leaves the clone as submitted', async () => {
    const h = await fixture(); await h.configure();
    const a = await h.member('a', 'clone'), b = await h.member('b', 'clone');
    await a.commit('shared.txt', 'from a\n'); const mine = await b.commit('shared.txt', 'from b\n');
    expect(await a.land()).toMatchObject({ status: 'landed' });
    expect(await b.land()).toMatchObject({ status: 'conflict' });
    expect(await git(b.ws.path, 'rev-parse', 'HEAD')).toBe(mine);
    expect(await git(b.ws.path, 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('freezes a clone\'s change into the source for an independent review snapshot', async () => {
    const h = await fixture(); const a = await h.member('a', 'clone');
    const head = await a.commit('feature.txt', 'feature\n'); a.idle();
    const change = await h.op<WorkspaceChange>('freeze', 'freeze', { workspace: a.ws.id });
    expect(change).toMatchObject({ headCommit: head, baseCommit: h.base, files: ['feature.txt'] });
    expect(await git(h.repo, 'rev-parse', `refs/bridge-workflow/${h.state.workflowId}/changes/${change.id}`)).toBe(head);
    const review = await h.op<WorkspaceBinding>('create', 'review', { change: change.id });
    expect(review.isolation).toBeUndefined();
    expect(await readFile(join(review.path, 'feature.txt'), 'utf8')).toBe('feature\n');
  }, 60_000);

  it('keeps a clone with unlanded work and removes a finished one together with the source\'s ref on it', async () => {
    const h = await fixture(); await h.configure();
    const ref = (ws: WorkspaceBinding) => `refs/bridge-workflow/${h.state.workflowId}/clones/${ws.id}`;
    const a = await h.member('a', 'clone'), b = await h.member('b', 'clone');
    expect(await git(h.repo, 'rev-parse', ref(a.ws))).toBe(h.base);
    await a.commit('a.txt', 'a\n'); await b.commit('b.txt', 'b\n');
    expect(await b.land()).toMatchObject({ status: 'landed' });
    a.idle(); b.idle();
    await expect(h.op('cleanup', 'clean-a', { workspace: a.ws.id })).rejects.toThrow('unintegrated');
    expect(await exists(a.ws.path)).toBe(true);
    expect(await h.op('cleanup', 'clean-b', { workspace: b.ws.id })).toMatchObject({ removed: true });
    expect(await exists(b.ws.path)).toBe(false);
    expect(await git(h.repo, 'for-each-ref', ref(b.ws))).toBe('');
    expect(await git(h.repo, 'for-each-ref', ref(a.ws))).not.toBe('');
    await expect(h.manager.binding(h.state.root, h.state.workflowId, b.ws.id, signal())).rejects.toThrow('unavailable');
  }, 60_000);

  it('finishes a removal that was interrupted half way', async () => {
    const h = await fixture(); const a = await h.member('a', 'clone'); a.idle();
    // The process died after recording the removal and deleting part of the clone.
    const db = (h.manager as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    const op = h.op('cleanup', 'clean', { workspace: a.ws.id });
    await op;
    db.prepare("UPDATE workspace_records SET done=0, data=? WHERE key='clean'").run(JSON.stringify({ removing: true }));
    db.prepare("UPDATE workspace_records SET data=json_set(data,'$.status','ready') WHERE id=?").run(a.ws.id);
    await mkdir(join(a.ws.path, '.git'), { recursive: true });
    expect(await h.op('cleanup', 'clean', { workspace: a.ws.id })).toMatchObject({ removed: true });
    expect(await exists(a.ws.path)).toBe(false);
  }, 60_000);

  it('validates the isolation option and refuses partial-clone sources', async () => {
    const h = await fixture();
    await expect(h.op('create', 'bad', { isolation: 'copy' })).rejects.toThrow('"worktree" or "clone"');
    expect(await h.op<WorkspaceBinding>('create', 'plain', { isolation: 'worktree' })).not.toHaveProperty('isolation');
    const a = await h.member('a', 'clone'); await a.commit('a.txt', 'a\n'); a.idle();
    const change = await h.op<WorkspaceChange>('freeze', 'freeze', { workspace: a.ws.id });
    await expect(h.op('create', 'both', { change: change.id, isolation: 'clone' })).rejects.toThrow('or change');
    await git(h.repo, 'config', 'remote.origin.promisor', 'true');
    await expect(h.op('create', 'partial', { isolation: 'clone' })).rejects.toThrow('partial-clone');
  }, 60_000);
});
