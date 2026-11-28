import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { access, mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowWorkspaces } from '../src/engine/workspaces';
import { records, workspaceCommand, type CommandOutput } from '../src/engine/workspace-process';
import { LARGE_PATHS, largeCommit, printed } from './helpers/large-tree';
import { WorkflowKernel } from '../src/engine/kernel';
import type { WorkspaceApproval, WorkspaceBinding, WorkspaceChange, WorkspaceChecks, WorkspaceIntegration } from '../src/engine/workspace-types';

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
  const dir = await mkdtemp(join(tmpdir(), 'workflow-worktrees-'));
  closes.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
  // Keep committed bytes intact; Windows git checks out CRLF by default.
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'shared.txt'), 'baseline\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  const base = await git(repo, 'rev-parse', 'HEAD');
  const root = { scopeId: 'scope', profile: 'test', agentKind: 'codex' as const, cwdRealpath: repo, policyFingerprint: 'full', catalogBinding: 'root', modelSettings: {} };
  const kernel = new WorkflowKernel(':memory:', { resolveRoot: async () => root, execute: async () => ({ status: 'completed' }), wakeMain: async () => {} });
  closes.push(() => kernel.close());
  await kernel.call({ kind: 'main', scopeId: 'scope', allowStart: true }, 'run_script', { operationId: 'start', goal: 'test', plan: 'test isolation', script: 'return null;' });
  const state = kernel.state('scope')!;
  const path = join(dir, 'workspaces.sqlite');
  let manager = new WorkflowWorkspaces(path, join(dir, 'worktrees'));
  closes.push(() => manager.close());
  const ctx = { state, signal: signal() };
  const op = <T>(kind: string, key: string, args: object = {}) => manager.perform(ctx, { kind, key, ...args }) as Promise<T>;
  const create = (key: string) => op<WorkspaceBinding>('create', key);
  const commit = async (ws: WorkspaceBinding, file: string, content: string) => {
    await writeFile(join(ws.path, file), content); await git(ws.path, 'add', '.'); await git(ws.path, 'commit', '-m', file);
  };
  const review = async (key: string, change: WorkspaceChange) => {
    const ws = await op<WorkspaceBinding>('create', key + '/snapshot', { change: change.id });
    const taskId = randomUUID(), resultRef = randomUUID();
    state.tasks.push({ taskId, taskKey: taskId, requestDigest: '', sessionRef: '', objective: 'review', inputRefs: [], status: 'result_ready', attempts: [], resultRefs: [resultRef], workspaceId: ws.id });
    state.script!.calls.push({ taskId, key: key + '/review', cached: false });
    state.artifacts.push({ ref: resultRef, kind: 'result', digest: '', text: JSON.stringify({ ok: true, reason: 'checked', evidence: ['Inspected frozen diff'] }), createdAt: Date.now(), taskId });
    const approval = await op<WorkspaceApproval>('approve', key + '/approve', { change: change.id, taskId });
    return { ws, approval, taskId };
  };
  const candidate = async (key: string, file: string, text: string) => {
    const ws = await create(key); await commit(ws, file, text);
    const change = await op<WorkspaceChange>('freeze', key + '/freeze', { workspace: ws.id });
    return { workspace: ws, change, ...await review(key, change) };
  };
  const checks = (ws: WorkspaceBinding, key = 'check', code = 'process.exit(0)') => op<WorkspaceChecks>('check', key, { workspace: ws.id, commands: [{ argv: [process.execPath, '-e', code] }] });
  return { dir, repo, base, root, state, path, ctx, get manager() { return manager; }, op, create, commit, review, candidate, checks,
    restart: async () => { await manager.close(); manager = new WorkflowWorkspaces(path, join(dir, 'worktrees')); } };
}

describe('managed workflow worktrees with real Git', () => {
  it('isolates parallel edits, pins review snapshots, and replays immutable records', async () => {
    const h = await fixture(); const [a, b] = await Promise.all([h.create('a'), h.create('b')]);
    await Promise.all([h.commit(a, 'shared.txt', 'A\n'), h.commit(b, 'shared.txt', 'B\n')]);
    expect(await readFile(join(h.repo, 'shared.txt'), 'utf8')).toBe('baseline\n');
    const change = await h.op<WorkspaceChange>('freeze', 'freeze', { workspace: a.id });
    const snapshot = await h.op<WorkspaceBinding>('create', 'snapshot', { change: change.id });
    await h.commit(a, 'later.txt', 'later\n');
    expect(await git(snapshot.path, 'rev-parse', 'HEAD')).toBe(change.headCommit);
    await h.restart();
    expect(await h.op('freeze', 'freeze', { workspace: a.id })).toEqual(change);
    expect((await h.create('a')).id).toBe(a.id);
    await expect(h.op('create', 'a', { base: h.base })).rejects.toThrow('key conflict');
    await expect(h.manager.binding(h.root, 'wrong-workflow', a.id, signal())).rejects.toThrow('ownership');
    await expect(h.manager.binding({ ...h.root, policyFingerprint: 'changed' }, h.state.workflowId, a.id, signal())).rejects.toThrow('authorization');
  }, 30_000);

  it('recovers creation with its original baseline after the root moves', async () => {
    const h = await fixture(), ws = await h.create('a');
    const db = new Database(h.path);
    db.prepare("UPDATE workspace_records SET done=0,data=? WHERE key='a'").run(JSON.stringify({repository:ws.repository,commonDir:ws.commonDir,baseCommit:ws.baseCommit}));
    db.close();
    await writeFile(join(h.repo,'later'),'root advanced'); await git(h.repo,'add','.'); await git(h.repo,'commit','-m','later');
    await h.restart();
    expect(await h.create('a')).toEqual(ws);
    expect(await git(ws.path,'rev-parse','HEAD')).toBe(h.base);
  }, 30_000);

  it('leaves the key of a creation that made nothing free for other inputs, and says what stood in the way', async () => {
    const h = await fixture();
    const rows = () => { const db = new Database(h.path); try { return (db.prepare("SELECT key FROM workspace_records WHERE kind='op:create'").all() as Array<{ key: string }>).map(row => row.key); } finally { db.close(); } };
    // An untracked file in the checkout: the refusal names it and the checkout, and records nothing.
    await writeFile(join(h.repo, 'stray'), 'x');
    await expect(h.create('member')).rejects.toThrow(/uncommitted changes \(\?\? stray, in .*repo\)/);
    expect(rows()).toEqual([]);
    await rm(join(h.repo, 'stray'));
    // A directory that is no checkout, named or taken from the workflow: each refusal says which directory and what to pass.
    const plain = join(h.dir, 'plain'); await mkdir(plain);
    await expect(h.op('create', 'member', { repo: plain })).rejects.toThrow('repo is not a Git checkout: ' + plain);
    const elsewhere = { ...h.ctx, state: { ...h.state, root: { ...h.root, cwdRealpath: plain } } };
    await expect(h.manager.perform(elsewhere, { kind: 'create', key: 'member' })).rejects.toThrow(/directory of this workflow is not a Git checkout \(.*plain\).*repo option/);
    expect(rows()).toEqual([]);
    // The key those attempts used takes inputs that work, and once a worktree exists it is held to them.
    const ws = await h.op<WorkspaceBinding>('create', 'member', { base: h.base });
    expect(await readFile(join(ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    await expect(h.create('member')).rejects.toThrow('key conflict');
    expect((await h.op<WorkspaceBinding>('create', 'member', { base: h.base })).id).toBe(ws.id);
  }, 30_000);

  it('takes over a creation that was left unfinished with nothing made, and keeps one that has a worktree', async () => {
    const h = await fixture(), made = await h.create('made');
    const db = new Database(h.path);
    // What an earlier version left of a creation that failed over its inputs: an unfinished record with no worktree.
    db.prepare("INSERT INTO workspace_records VALUES (?,?,?,'op:create','digest-of-other-inputs',0,'{}',?)").run(randomUUID(), h.state.workflowId, 'stuck', Date.now());
    // An unfinished creation that did make a worktree is still held to its inputs.
    db.prepare("UPDATE workspace_records SET done=0 WHERE key='made'").run();
    db.close();
    await h.restart();
    const ws = await h.create('stuck');
    expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
    await expect(h.op('create', 'made', { base: h.base })).rejects.toThrow('key conflict');
    expect((await h.create('made')).id).toBe(made.id);
  }, 30_000);

  it('tells where a worktree came from as the options that make another like it', async () => {
    const h = await fixture(), ws = await h.create('a');
    expect(h.manager.origin(h.state.workflowId, ws.id)).toEqual({ repo: ws.repository });
    const clone = await h.op<WorkspaceBinding>('create', 'c', { isolation: 'clone' });
    expect(h.manager.origin(h.state.workflowId, clone.id)).toEqual({ repo: ws.repository, isolation: 'clone' });
    expect(() => h.manager.origin('another-workflow', ws.id)).toThrow('ownership');
  }, 30_000);

  it('creates a batch of worktrees at once, each at its baseline and clean', async () => {
    const h = await fixture();
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => h.create('batch/' + i)));
    expect(new Set(made.map(ws => ws.id)).size).toBe(12);
    for (const ws of made) {
      expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(h.base);
      expect(await git(ws.path, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(await readFile(join(ws.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    }
  }, 60_000);

  it('keeps a worktree a worktree when the shared repository is made bare, and mends one made before the mark', async () => {
    const h = await fixture();
    // What `git sparse-checkout` turns on. Only with it does Git apply the shared `core.bare` to a linked worktree, and
    // only with it does Git read what a worktree says for itself.
    await git(h.repo, 'config', 'extensions.worktreeConfig', 'true');
    const ws = await h.create('a');
    const gitDir = await git(ws.path, 'rev-parse', '--absolute-git-dir');
    // What a stray `git config` run in a directory that is not a repository of its own can write: every linked worktree
    // would be treated as bare, and every member of the workflow would fail at once.
    await git(h.repo, 'config', 'core.bare', 'true');
    expect(await git(ws.path, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    await h.commit(ws, 'after.txt', 'after\n');
    expect((await h.manager.binding(h.root, h.state.workflowId, ws.id, signal())).id).toBe(ws.id);
    // A worktree made before this mark existed has none, and is given one the first time it is found bare.
    await rm(join(gitDir, 'config.worktree'));
    await expect(h.manager.binding(h.root, h.state.workflowId, ws.id, signal())).resolves.toMatchObject({ id: ws.id });
    expect(await git(ws.path, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    await h.commit(ws, 'mended.txt', 'mended\n');
  }, 30_000);

  it('names the shared repository and its repair when a worktree cannot be mended', async () => {
    const h = await fixture();
    await git(h.repo, 'config', 'extensions.worktreeConfig', 'true');
    const ws = await h.create('a');
    const gitDir = await git(ws.path, 'rev-parse', '--absolute-git-dir');
    await rm(join(gitDir, 'config.worktree'));
    await git(h.repo, 'config', 'core.bare', 'true');
    // The mark cannot be written while its lock is held: Git keeps refusing, and the refusal names what to run rather
    // than the command that failed.
    await writeFile(join(gitDir, 'config.worktree.lock'), '');
    await expect(h.manager.binding(h.root, h.state.workflowId, ws.id, signal())).rejects.toThrow(/core\.bare = true in its shared config.*git -C .*repo config --unset core\.bare/);
  }, 30_000);

  it('leaves the shared configuration of a repository as it found it', async () => {
    const h = await fixture();
    // The user's own worktree of the same repository, which this service never marks.
    const own = join(h.dir, 'own'); await git(h.repo, 'worktree', 'add', '-b', 'own', own);
    const ws = await h.create('a');
    // With `extensions.worktreeConfig` off, Git keeps a shared `core.bare` from every linked worktree. Turning it on to
    // have the mark read would take that away from the worktrees this service did not make.
    expect(await git(h.repo, 'config', '--local', '--list')).not.toMatch(/^extensions\./m);
    await git(h.repo, 'config', 'core.bare', 'true');
    for (const path of [own, ws.path]) expect(await git(path, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    await h.commit(ws, 'after.txt', 'after\n');
  }, 30_000);

  it('works beside the other worktrees of a repository that is kept bare', async () => {
    const h = await fixture();
    // Every checkout of such a repository is a linked worktree, and its shared config says `core.bare = true` by design.
    const store = join(h.dir, 'store.git'), checkout = join(h.dir, 'checkout');
    await git(h.dir, 'clone', '--bare', h.repo, store);
    await git(store, 'config', 'user.name', 'Test'); await git(store, 'config', 'user.email', 'test@localhost'); await git(store, 'config', 'core.autocrlf', 'false');
    await git(store, 'worktree', 'add', checkout, 'main');
    const ws = await h.op<WorkspaceBinding>('create', 'a', { repo: checkout });
    await h.commit(ws, 'member.txt', 'member\n');
    expect(await git(checkout, 'status', '--porcelain')).toBe('');
    // The bare repository itself is no checkout, and nobody is told to stop it being bare.
    await expect(h.op('create', 'b', { repo: store })).rejects.toThrow('repo is not a Git checkout: ' + store);
  }, 30_000);

  it('writes the files of a worktree registered before an interrupted create', async () => {
    const h = await fixture(), ws = await h.create('a');
    const db = new Database(h.path);
    db.prepare("UPDATE workspace_records SET done=0 WHERE key='a'").run();
    const row = db.prepare("SELECT id,data FROM workspace_records WHERE kind='workspace'").get() as { id: string; data: string };
    db.prepare('UPDATE workspace_records SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.data), status: 'preparing' }), row.id);
    db.close();
    // A create that died after `git worktree add --no-checkout` leaves the directory registered but empty.
    await rm(join(ws.path, 'shared.txt'));
    await h.restart();
    const again = await h.create('a');
    expect(again.id).toBe(ws.id);
    expect(await readFile(join(again.path, 'shared.txt'), 'utf8')).toBe('baseline\n');
    expect(await git(again.path, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  }, 30_000);

  it('merges independently approved changes, checks the combination, and accepts only a private branch', async () => {
    const h = await fixture(); const a = await h.candidate('a', 'a.txt', 'A\n'), b = await h.candidate('b', 'b.txt', 'B\n');
    const input = { approvals: [a.approval.id, b.approval.id] };
    const merged = await h.op<WorkspaceIntegration>('integrate', 'merge', input);
    expect(merged.status).toBe('prepared');
    expect(await readFile(join(merged.workspace.path, 'a.txt'), 'utf8')).toBe('A\n');
    expect(await readFile(join(merged.workspace.path, 'b.txt'), 'utf8')).toBe('B\n');
    const checks = await h.checks(merged.workspace, 'check', `const fs=require('fs');if(!fs.existsSync('a.txt')||!fs.existsSync('b.txt'))process.exit(1)`);
    const accepted = await h.op('accept', 'accept', { workspace: merged.workspace.id, checks: checks.id });
    expect(await git(h.repo, 'rev-parse', merged.targetRef)).toBe(merged.headCommit);
    expect(await git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
    await h.restart(); expect(await h.op('integrate', 'merge', input)).toEqual(merged);
    expect(await h.op('accept', 'accept', { workspace: merged.workspace.id, checks: checks.id })).toEqual(accepted);
    expect(await h.op('cleanup', 'clean', { workspace: merged.workspace.id })).toMatchObject({ removed: true });
  }, 60_000);

  it('blocks a bad combined result and rejects changes made after passing checks', async () => {
    const h = await fixture(); const a = await h.candidate('a', 'a.txt', 'A\n'), b = await h.candidate('b', 'b.txt', 'B\n');
    const merged = await h.op<WorkspaceIntegration>('integrate', 'merge', { approvals: [a.approval.id, b.approval.id] });
    const failed = await h.checks(merged.workspace, 'fail', `const fs=require('fs');process.exit(fs.existsSync('a.txt')&&fs.existsSync('b.txt')?1:0)`);
    expect(failed.passed).toBe(false);
    await expect(h.op('accept', 'bad', { workspace: merged.workspace.id, checks: failed.id })).rejects.toThrow('Passing checks');
    const checks = await h.checks(merged.workspace);
    await h.commit(merged.workspace, 'extra.txt', 'unreviewed\n');
    await expect(h.op('accept', 'changed', { workspace: merged.workspace.id, checks: checks.id })).rejects.toThrow('unchanged integration');
  }, 60_000);

  it('retains conflicts and supports independently reviewed repair plus remaining candidates', async () => {
    const h = await fixture(); const a = await h.candidate('a', 'shared.txt', 'A\n'), b = await h.candidate('b', 'shared.txt', 'B\n'), c = await h.candidate('c', 'c.txt', 'C\n');
    const merged = await h.op<WorkspaceIntegration>('integrate', 'merge', { approvals: [a.approval.id, b.approval.id, c.approval.id] });
    expect(merged.status).toBe('conflict'); expect(merged.remaining).toEqual([c.approval.id]);
    await expect(h.op('accept', 'bad', { workspace: merged.workspace.id, checks: 'none' })).rejects.toThrow('Repair');
    await h.commit(merged.workspace, 'shared.txt', 'A and B\n');
    const repair = await h.op<WorkspaceChange>('freeze', 'repair', { workspace: merged.workspace.id });
    const reviewed = await h.review('repair', repair);
    const fixed = await h.op<WorkspaceIntegration>('integrate', 'fixed', { approvals: [reviewed.approval.id, ...merged.remaining] });
    expect(fixed.status).toBe('prepared');
    expect(await readFile(join(fixed.workspace.path, 'shared.txt'), 'utf8')).toBe('A and B\n');
    expect(await readFile(join(fixed.workspace.path, 'c.txt'), 'utf8')).toBe('C\n');
    const checks = await h.checks(fixed.workspace);
    await h.op('accept', 'accept', { workspace: fixed.workspace.id, checks: checks.id });
  }, 90_000);

  it('removes a workspace with uncommitted and unintegrated changes, discarding them', async () => {
    const h = await fixture(); const ws = await h.create('a');
    await writeFile(join(ws.path, 'dirty.txt'), 'dirty\n');
    await h.commit(ws, 'committed.txt', 'committed\n');
    expect(await h.op('cleanup', 'clean', { workspace: ws.id })).toMatchObject({ removed: true });
    expect(await exists(ws.path)).toBe(false);
  }, 30_000);

  it('requires clean, independent, current-run snapshot review evidence', async () => {
    const h = await fixture(); const ws = await h.create('a');
    await writeFile(join(ws.path, 'junk'), 'untracked');
    await expect(h.op('freeze', 'dirty', { workspace: ws.id })).rejects.toThrow('untracked');
    await git(ws.path, 'add', '.'); await git(ws.path, 'commit', '-m', 'candidate');
    const change = await h.op<WorkspaceChange>('freeze', 'frozen', { workspace: ws.id });
    const review = await h.review('r', change);
    h.state.script!.calls = [];
    await expect(h.op('approve', 'old', { change: change.id, taskId: review.taskId })).rejects.toThrow('current script run');
    h.state.script!.calls.push({ key: 'review', taskId: review.taskId, cached: true });
    h.state.tasks.at(-1)!.agentId = 'writer';
    await expect(h.op('approve', 'member', { change: change.id, taskId: review.taskId })).rejects.toThrow('independent');
    delete h.state.tasks.at(-1)!.agentId;
    await h.commit(review.ws, 'changed.txt', 'changed\n');
    await expect(h.op('approve', 'mutated', { change: change.id, taskId: review.taskId })).rejects.toThrow('Reviewer changed');
  }, 30_000);

  it('serializes check ownership against workers and preserves uncertain ownership across restart', async () => {
    const h = await fixture(), ws = await h.create('a');
    const check = h.checks(ws, 'slow', 'setTimeout(()=>{},1500)');
    await vi.waitFor(async () => expect((await h.manager.binding(h.root, h.state.workflowId, ws.id, signal())).busy).toBeDefined());
    expect(() => h.manager.begin(ws, 'worker')).toThrow('owner');
    await expect(h.op('freeze', 'busy', { workspace: ws.id })).rejects.toThrow('Wait');
    await check;
    const lease = h.manager.begin(ws, 'worker');
    await h.restart(); expect(() => h.manager.begin(ws, 'second')).toThrow('owner');
    h.manager.end(ws, lease);
    expect(await h.op('cleanup', 'clean', { workspace: ws.id })).toMatchObject({ removed: true });
  }, 30_000);

  it('uses target CAS and never treats a failed acceptance intent as accepted', async () => {
    const h = await fixture(), a = await h.candidate('a', 'a.txt', 'A\n');
    const merged = await h.op<WorkspaceIntegration>('integrate', 'merge', { approvals: [a.approval.id] });
    const checks = await h.checks(merged.workspace);
    await git(h.repo, 'update-ref', merged.targetRef, h.base);
    await expect(h.op('accept', 'stale', { workspace: merged.workspace.id, checks: checks.id })).rejects.toThrow('target advanced');
    expect(await h.op('cleanup', 'keep', { workspace: merged.workspace.id })).toMatchObject({ removed: true });
  }, 30_000);

  it('does not update a private integration branch checked out by a user', async () => {
    const h = await fixture(), a = await h.candidate('a', 'a.txt', 'A\n');
    const ref = `refs/heads/bridge-workflow/${h.state.workflowId}/result`;
    await git(h.repo, 'update-ref', ref, h.base);
    const merged = await h.op<WorkspaceIntegration>('integrate', 'merge', { approvals: [a.approval.id] });
    await git(h.repo, 'checkout', ref.replace('refs/heads/', ''));
    const checks = await h.checks(merged.workspace);
    await expect(h.op('accept', 'accept', { workspace: merged.workspace.id, checks: checks.id })).rejects.toThrow('checked out');
    expect(await git(h.repo, 'rev-parse', 'HEAD')).toBe(h.base);
  }, 60_000);

  it('reconciles update-ref-before-journal and remove-before-journal crash windows', async () => {
    const h = await fixture(), a = await h.candidate('a', 'a.txt', 'A\n');
    const merged = await h.op<WorkspaceIntegration>('integrate', 'merge', { approvals: [a.approval.id] });
    const checks = await h.checks(merged.workspace);
    await h.op('accept', 'accept', { workspace: merged.workspace.id, checks: checks.id });
    const db = new Database(h.path);
    db.prepare("UPDATE workspace_records SET done=0,data=? WHERE key='merge'").run(JSON.stringify({baseCommit:h.base,expectedHead:null}));
    expect(await h.op('integrate', 'merge', {approvals:[a.approval.id]})).toEqual(merged);
    db.prepare("UPDATE workspace_records SET done=0,data='{}' WHERE key='accept'").run();
    db.prepare("UPDATE workspace_records SET data=json_set(data,'$.completed',json('false')) WHERE kind='accepted'").run();
    expect(await h.op('accept', 'accept', { workspace: merged.workspace.id, checks: checks.id })).toMatchObject({ completed: true });
    await h.op('cleanup', 'clean', { workspace: merged.workspace.id });
    db.prepare("UPDATE workspace_records SET done=0,data=? WHERE key='clean'").run(JSON.stringify({ removing: true, token: 'remover' }));
    db.prepare("UPDATE workspace_records SET data=json_set(data,'$.status','ready','$.busy',json(?)) WHERE id=?").run(JSON.stringify({ token: 'remover', ownerPid: 1 }), merged.workspace.id);
    db.close(); await h.restart();
    expect(await h.op('cleanup', 'clean', { workspace: merged.workspace.id })).toMatchObject({ removed: true });
  }, 30_000);

  it('rejects submodules, filter attributes, arbitrary refs and dirty root checkouts', async () => {
    const h = await fixture();
    await writeFile(join(h.repo, 'dirty'), 'x');
    await expect(h.create('dirty')).rejects.toThrow('uncommitted');
    await rm(join(h.repo, 'dirty'));
    await expect(h.op('create', 'ref', { base: 'main' })).rejects.toThrow('full commit');
    const ws = await h.create('a'); await h.commit(ws, '.gitattributes', 'data.bin filter=lfs\n');
    await expect(h.op('freeze', 'filter', { workspace: ws.id })).rejects.toThrow('filters');
    await git(ws.path, 'reset', '--hard', h.base);
    await git(ws.path, 'update-index', '--add', '--cacheinfo', `160000,${h.base},sub`); await git(ws.path, 'commit', '-m', 'submodule');
    await expect(h.op('create', 'sub', { base: await git(ws.path, 'rev-parse', 'HEAD') })).rejects.toThrow('submodules');
  }, 30_000);

  it('aborts and times out foreground commands before releasing their workspace', async () => {
    const h = await fixture(), ws = await h.create('a'), controller = new AbortController();
    const running = h.manager.perform({ ...h.ctx, signal: controller.signal }, { kind: 'check', key: 'abort', workspace: ws.id, commands: [{ argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'] }] });
    const settled = running.then(() => {}, () => {});
    try {
      // Real Git setup can exceed vi.waitFor's default one second on Windows.
      await vi.waitFor(async () => expect((await h.manager.binding(h.root, h.state.workflowId, ws.id, signal())).busy).toBeDefined(), { timeout: 10_000 });
      controller.abort(); await expect(running).rejects.toThrow('aborted');
    } finally {
      // A failed readiness assertion must still drain the owned foreground command.
      controller.abort(); await settled;
    }
    expect((await h.manager.binding(h.root, h.state.workflowId, ws.id, signal())).busy).toBeUndefined();
    await expect(h.op('check', 'timeout', { workspace: ws.id, commands: [{ argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'], timeoutMs: 100 }] })).rejects.toThrow('timed out');
  }, 30_000);

  it('takes a check timeout well past five minutes but not past four hours', async () => {
    const h = await fixture(), ws = await h.create('a');
    const commands = (timeoutMs: number) => [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs }];
    expect(await h.op<WorkspaceChecks>('check', 'long', { workspace: ws.id, commands: commands(40 * 60_000) })).toMatchObject({ passed: true });
    await expect(h.op('check', 'over', { workspace: ws.id, commands: commands(4 * 3_600_000 + 1) })).rejects.toThrow('Expected an integer');
  }, 30_000);
});

describe('what is held of a workspace command\'s output', () => {
  const node = (code: string, output?: CommandOutput) => workspaceCommand(process.execPath, ['-e', code], tmpdir(), signal(), 60_000, process.env, undefined, output);

  it('holds the whole output up to a limit, or one end of it, and then lets the command print on', async () => {
    const flood = "process.stdout.write('START'+'x'.repeat(3e6)+'END');process.stderr.write('e'.repeat(3e6)+'LAST')";
    await expect(node(flood, { name: 'flood' })).rejects.toThrow('Workspace command output limit reached: flood printed more than 2 MB');
    const tail = await node(flood, { keep: 'tail', bytes: 1000 });
    expect([tail.code, tail.stdout.length, tail.stdout.endsWith('xEND'), tail.stderr.length, tail.stderr.endsWith('eLAST')]).toEqual([0, 1000, true, 1000, true]);
    const head = await node(flood, { keep: 'head', bytes: 1000 });
    expect([head.code, head.stdout.length, head.stdout.startsWith('STARTx'), head.stderr]).toEqual([0, 1000, true, 'e'.repeat(1000)]);
    // Output that fits is the same whichever way it is held.
    for (const output of [undefined, { keep: 'tail' as const }, { keep: 'head' as const }]) expect(await node("console.log('目录');console.error('文件')", output)).toEqual({ code: 0, stdout: '目录\n', stderr: '文件\n' });
  }, 60_000);

  it('hands a scanning caller every record of a listing however its chunks fall, and holds none of it', async () => {
    // 2.7 MB of records with multi-byte names, written so that chunks end inside records and inside characters.
    const listing = "let text='';for(let i=0;i<60000;i++)text+='目录/文件-'+i+'-'+'y'.repeat(20)+'\\0';for(let at=0;at<text.length;at+=7001)process.stdout.write(Buffer.from(text).subarray(at,at+7001));process.stderr.write('note')";
    const seen: string[] = [];
    let wrong = 0;
    const result = await node(listing.replace('text.length', 'Buffer.byteLength(text)'), { scan: records(record => { if (!/^目录\/文件-\d+-y{20}$/.test(record)) wrong++; seen.push(record.split('-')[1]!); }) });
    expect(result).toEqual({ code: 0, stdout: '', stderr: 'note' });
    expect([wrong, seen.length, seen[0], seen.at(-1)]).toEqual([0, 60000, '0', '59999']);
    // A caller that has seen enough stops the command with its own error.
    await expect(node("setInterval(()=>process.stdout.write('x'.repeat(1e4)+'\\n'),1)", { scan: records(() => { throw new Error('seen enough'); }, '\n') })).rejects.toThrow('seen enough');
  }, 60_000);
});

// Windows cannot check out paths as long as the ones that make these listings large.
describe.skipIf(process.platform === 'win32')('worktrees of a repository with more files than a command may list whole', () => {
  it('makes a worktree from a large tree and still refuses submodules and filters anywhere in it', async () => {
    const h = await fixture();
    const large = largeCommit(h.repo, h.base);
    expect(printed(h.repo, 'ls-tree', '-r', '-z', large)).toBeGreaterThan(2_000_000);
    const ws = await h.op<WorkspaceBinding>('create', 'large', { base: large });
    expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(large);
    expect(await exists(join(ws.path, LARGE_PATHS.at(-1)!))).toBe(true);
    expect(await git(ws.path, 'status', '--porcelain')).toBe('');
    // Its last entries are screened like its first.
    await expect(h.op('create', 'filter', { base: largeCommit(h.repo, h.base, { files: { 'zz/.gitattributes': '*.bin filter=lfs\n' } }) })).rejects.toThrow('filters');
    await expect(h.op('create', 'submodule', { base: largeCommit(h.repo, h.base, { submodule: 'zz/sub' }) })).rejects.toThrow('submodules');
    // A frozen change records every path it touches, so one that names this many is refused, and the refusal says by what.
    const member = await h.create('member'); await git(member.path, 'reset', '--hard', large);
    await expect(h.op('freeze', 'freeze', { workspace: member.id })).rejects.toThrow('Workspace command output limit reached: git diff printed more than 2 MB');
  }, 120_000);

  it('freezes a change whose diff is larger than a command may print whole, and records the digest of that diff', async () => {
    const h = await fixture(), ws = await h.create('a');
    await h.commit(ws, 'large.txt', Array.from({ length: 60_000 }, (_, index) => `line ${index} ${'z'.repeat(40)}`).join('\n') + '\n');
    const diff = execFileSync('git', ['diff', '--binary', h.base, 'HEAD'], { cwd: ws.path, maxBuffer: 64 << 20 });
    expect(diff.length).toBeGreaterThan(2_000_000);
    const change = await h.op<WorkspaceChange>('freeze', 'freeze', { workspace: ws.id });
    expect(change).toMatchObject({ files: ['large.txt'], diffDigest: createHash('sha256').update(diff).digest('hex') });
  }, 60_000);

  it('counts the untracked files that keep a checkout from being a baseline without listing them all', async () => {
    const h = await fixture();
    await mkdir(join(h.repo, 'stray'));
    for (let index = 0; index < 9600; index++) writeFileSync(join(h.repo, 'stray', `${'u'.repeat(200)}-${index}`), '');
    expect(printed(h.repo, 'status', '--porcelain', '--untracked-files=all')).toBeGreaterThan(2_000_000);
    // Each name is cut to 200 characters in the refusal.
    await expect(h.create('member')).rejects.toThrow(/uncommitted changes \((\?\? stray\/u{191}, ){5}and 9595 more, in .*repo\)/);
  }, 120_000);
});
