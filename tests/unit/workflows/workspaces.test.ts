import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowWorkspaces } from '../../../src/workflows/workspaces';
import { workspaceCommand } from '../../../src/workflows/workspace-process';
import { WorkflowKernel } from '../../../src/workflows/kernel';
import type { WorkspaceApproval, WorkspaceBinding, WorkspaceChange, WorkspaceChecks, WorkspaceIntegration } from '../../../src/workflows/workspace-types';

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function git(cwd: string, ...argv: string[]) {
  const result = await workspaceCommand('git', argv, cwd, signal());
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-worktrees-'));
  closes.push(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@localhost');
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
  }, 30_000);

  it('blocks a bad combined result and rejects changes made after passing checks', async () => {
    const h = await fixture(); const a = await h.candidate('a', 'a.txt', 'A\n'), b = await h.candidate('b', 'b.txt', 'B\n');
    const merged = await h.op<WorkspaceIntegration>('integrate', 'merge', { approvals: [a.approval.id, b.approval.id] });
    const failed = await h.checks(merged.workspace, 'fail', `const fs=require('fs');process.exit(fs.existsSync('a.txt')&&fs.existsSync('b.txt')?1:0)`);
    expect(failed.passed).toBe(false);
    await expect(h.op('accept', 'bad', { workspace: merged.workspace.id, checks: failed.id })).rejects.toThrow('Passing checks');
    const checks = await h.checks(merged.workspace);
    await h.commit(merged.workspace, 'extra.txt', 'unreviewed\n');
    await expect(h.op('accept', 'changed', { workspace: merged.workspace.id, checks: checks.id })).rejects.toThrow('unchanged integration');
  }, 30_000);

  it('retains conflicts and supports independently reviewed repair plus remaining candidates', async () => {
    const h = await fixture(); const a = await h.candidate('a', 'shared.txt', 'A\n'), b = await h.candidate('b', 'shared.txt', 'B\n'), c = await h.candidate('c', 'c.txt', 'C\n');
    const merged = await h.op<WorkspaceIntegration>('integrate', 'merge', { approvals: [a.approval.id, b.approval.id, c.approval.id] });
    expect(merged.status).toBe('conflict'); expect(merged.remaining).toEqual([c.approval.id]);
    await expect(h.op('accept', 'bad', { workspace: merged.workspace.id, checks: 'none' })).rejects.toThrow('Repair');
    await expect(h.op('cleanup', 'keep', { workspace: merged.workspace.id })).rejects.toThrow('unintegrated');
    await h.commit(merged.workspace, 'shared.txt', 'A and B\n');
    const repair = await h.op<WorkspaceChange>('freeze', 'repair', { workspace: merged.workspace.id });
    const reviewed = await h.review('repair', repair);
    const fixed = await h.op<WorkspaceIntegration>('integrate', 'fixed', { approvals: [reviewed.approval.id, ...merged.remaining] });
    expect(fixed.status).toBe('prepared');
    expect(await readFile(join(fixed.workspace.path, 'shared.txt'), 'utf8')).toBe('A and B\n');
    expect(await readFile(join(fixed.workspace.path, 'c.txt'), 'utf8')).toBe('C\n');
    const checks = await h.checks(fixed.workspace);
    await h.op('accept', 'accept', { workspace: fixed.workspace.id, checks: checks.id });
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
    await expect(h.op('cleanup', 'keep', { workspace: merged.workspace.id })).rejects.toThrow('unintegrated');
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
  }, 30_000);

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
    await vi.waitFor(async () => expect((await h.manager.binding(h.root, h.state.workflowId, ws.id, signal())).busy).toBeDefined());
    controller.abort(); await expect(running).rejects.toThrow('aborted');
    expect((await h.manager.binding(h.root, h.state.workflowId, ws.id, signal())).busy).toBeUndefined();
    await expect(h.op('check', 'timeout', { workspace: ws.id, commands: [{ argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'], timeoutMs: 100 }] })).rejects.toThrow('timed out');
  });
});
