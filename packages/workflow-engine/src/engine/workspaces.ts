import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { access, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { workflowDigest } from './digest';
import { boundedInteger, scriptText } from './script-contract';
import { nodeProcesses, workspaceCommand, type CommandResult } from './workspace-process';
import type { WorkflowProcesses } from './ports';
import type { WorkspaceApproval, WorkspaceBinding, WorkspaceChange, WorkspaceChecks, WorkspaceContext, WorkspaceIntegration } from './workspace-types';
import type { WorkflowRoot } from './types';

interface RecordRow { id: string; workflow: string; key: string; kind: string; digest: string; done: number; data: string; created: number }
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const BUSY = new Set(['queued', 'starting', 'running', 'cancelling', 'waiting_workflow']);
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });

/** The journal precedes Git/filesystem operations. Successful results are immutable on replay. */
export class WorkflowWorkspaces {
  private readonly db: Database.Database;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly activeKeys = new Set<string>();
  private closed = false;

  constructor(path: string, private readonly directory: string, private readonly processes: WorkflowProcesses = nodeProcesses) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_records (
      id TEXT PRIMARY KEY, workflow TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
      digest TEXT NOT NULL, done INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL,
      UNIQUE(workflow,key));`);
  }

  private row(id: string, workflow: string, kind?: string): RecordRow {
    const row = this.db.prepare('SELECT * FROM workspace_records WHERE id=? AND workflow=?').get(id, workflow) as RecordRow | undefined;
    if (!row || kind && row.kind !== kind) throw new Error('Unknown workspace artifact or wrong workflow ownership');
    return row;
  }
  private value<T>(id: string, workflow: string, kind: string): T { return JSON.parse(this.row(id, workflow, kind).data) as T; }
  private save(row: RecordRow, value: unknown, done = row.done): void {
    this.db.prepare('UPDATE workspace_records SET data=?,done=? WHERE id=?').run(JSON.stringify(value), done, row.id);
  }
  private insert(workflow: string, key: string, kind: string, value: unknown, digest = '', done = 1): RecordRow {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM workspace_records WHERE workflow=?').get(workflow) as { n: number }).n;
    if (count >= 512) throw new Error('Workspace artifact budget reached');
    const row = { id: randomUUID(), workflow, key, kind, digest, done, data: JSON.stringify(value), created: Date.now() };
    this.db.prepare('INSERT INTO workspace_records VALUES (@id,@workflow,@key,@kind,@digest,@done,@data,@created)').run(row);
    return row;
  }
  private internal<T>(op: RecordRow, kind: string, suffix: string, make: (id: string) => T): T {
    const key = `@${op.id}/${suffix}`;
    return this.db.transaction(() => {
      let row = this.db.prepare('SELECT * FROM workspace_records WHERE workflow=? AND key=?').get(op.workflow, key) as RecordRow | undefined;
      if (row) return JSON.parse(row.data) as T;
      row = this.insert(op.workflow, key, kind, null);
      const value = make(row.id); this.save(row, value); return value;
    })();
  }
  private putWorkspace(workspace: WorkspaceBinding): void { this.save(this.row(workspace.id, workspace.workflowId, 'workspace'), workspace); }

  private async git(cwd: string, args: string[], signal: AbortSignal, allowFailure = false, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
    const hooks = join(this.directory, 'empty-hooks'); await mkdir(hooks, { recursive: true, mode: 0o700 });
    const result = await workspaceCommand('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false',
      '-c', 'gc.auto=0', ...args], cwd, signal, 60_000, { ...gitEnv(), ...env }, this.processes);
    if (result.code && !allowFailure) throw new Error(`Git ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 1600)}`);
    return result;
  }
  private async revision(repo: string, value: unknown, signal: AbortSignal): Promise<string> {
    if (value !== undefined && (typeof value !== 'string' || !SHA.test(value))) throw new Error('Workspace base must be a full commit ID');
    const head = (await this.git(repo, ['rev-parse', '--verify', `${value ?? 'HEAD'}^{commit}`], signal)).stdout.trim();
    if (!SHA.test(head)) throw new Error('Invalid repository revision');
    return head;
  }
  private async supportedTree(repo: string, head: string, signal: AbortSignal): Promise<void> {
    const tree = (await this.git(repo, ['ls-tree', '-r', '-z', head], signal)).stdout;
    if (tree.split('\0').some(entry => entry.startsWith('160000 '))) throw new Error('Workspace v1 does not support submodules');
    const attributes = tree.split('\0').map(line => line.slice(line.indexOf('\t') + 1)).filter(path => path === '.gitattributes' || path.endsWith('/.gitattributes'));
    for (const path of attributes) {
      const text = (await this.git(repo, ['show', `${head}:${path}`], signal)).stdout;
      if (/\bfilter\s*=/.test(text)) throw new Error('Workspace v1 does not support checkout filters or Git LFS');
    }
  }
  private async repository(root: WorkflowRoot, signal: AbortSignal): Promise<{ repository: string; commonDir: string }> {
    const repository = await realpath((await this.git(root.cwdRealpath, ['rev-parse', '--show-toplevel'], signal)).stdout.trim());
    if (repository !== await realpath(root.cwdRealpath)) throw new Error('Workspace operations require the authorized repository root as cwd');
    const commonDir = await realpath(resolve(repository, (await this.git(repository, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()));
    return { repository, commonDir };
  }

  async binding(root: WorkflowRoot, workflowId: string, id: string, signal: AbortSignal): Promise<WorkspaceBinding> {
    const ws = this.value<WorkspaceBinding>(id, workflowId, 'workspace');
    if (ws.rootDigest !== workflowDigest(root) || ws.status !== 'ready') throw new Error('Workspace binding is unavailable or authorization changed');
    const top = await realpath((await this.git(ws.path, ['rev-parse', '--show-toplevel'], signal)).stdout.trim());
    const common = await realpath(resolve(ws.path, (await this.git(ws.path, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()));
    if (top !== await realpath(ws.path) || common !== ws.commonDir
      || top !== join(await realpath(this.directory), workflowId, ws.id)) throw new Error('Workspace path or repository identity changed');
    return ws;
  }
  begin(ws: WorkspaceBinding, taskId?: string): string {
    return this.db.transaction(() => {
      const current = this.value<WorkspaceBinding>(ws.id, ws.workflowId, 'workspace');
      if (current.status !== 'ready') throw new Error('Workspace is unavailable');
      if (current.busy) throw new Error('Workspace still has an execution owner; after an unclean crash preserve it and use a new workspace key unless termination has been established');
      const token = randomUUID(); current.busy = { token, taskId, ownerPid: process.pid }; this.putWorkspace(current); return token;
    })();
  }
  end(ws: WorkspaceBinding, token: string): void {
    const current = this.value<WorkspaceBinding>(ws.id, ws.workflowId, 'workspace');
    if (current.busy?.token !== token) throw new Error('Workspace execution ownership changed');
    delete current.busy; this.putWorkspace(current);
  }
  private idle(ws: WorkspaceBinding, ctx: WorkspaceContext): void {
    if (ws.busy || ctx.state.tasks.some(task => task.workspaceId === ws.id && BUSY.has(task.status))) throw new Error('Wait for every workspace task to exit before inspecting or changing it');
  }
  async clean(ws: WorkspaceBinding, signal: AbortSignal): Promise<{ headCommit: string; tree: string }> {
    const headCommit = await this.revision(ws.path, undefined, signal);
    if ((await this.git(ws.path, ['status', '--porcelain', '--untracked-files=all'], signal)).stdout.trim()) throw new Error('Workspace has uncommitted or untracked changes; commit the intended changes before freezing or validating');
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
      if (!(await this.git(ws.path, ['rev-parse', '--verify', name], signal, true)).code) throw new Error('Workspace still has an unfinished Git operation');
    }
    return { headCommit, tree: (await this.git(ws.path, ['rev-parse', `${headCommit}^{tree}`], signal)).stdout.trim() };
  }
  async verifySnapshot(ws: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    if (ws.kind === 'review' && (await this.clean(ws, signal)).headCommit !== ws.baseCommit) throw new Error('Reviewer changed the frozen candidate');
  }

  private async materialize(ctx: WorkspaceContext, op: RecordRow, seed: { repository: string; commonDir: string; baseCommit: string; kind: WorkspaceBinding['kind']; changeId?: string }, checkout = seed.baseCommit): Promise<WorkspaceBinding> {
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE workflow=? AND kind='workspace'").get(op.workflow) as { n: number }).n;
    const existing = this.db.prepare('SELECT id FROM workspace_records WHERE workflow=? AND key=?').get(op.workflow, `@${op.id}/workspace`);
    if (!existing && count >= 32) throw new Error('Workspace budget reached (32 per workflow)');
    let ws = this.internal<WorkspaceBinding>(op, 'workspace', 'workspace', id => ({ id, workflowId: op.workflow,
      rootDigest: workflowDigest(ctx.state.root), path: join(resolve(this.directory), op.workflow, id), status: 'preparing', ...seed }));
    if (ws.status === 'removed') throw new Error('Workspace was removed; use a new workspace key');
    if (ws.status === 'ready') {
      const bound = await this.binding(ctx.state.root, op.workflow, ws.id, ctx.signal);
      if ((await this.clean(bound, ctx.signal)).headCommit !== checkout) throw new Error('Recovered worktree does not match its planned revision');
      return bound;
    }
    await mkdir(dirname(ws.path), { recursive: true, mode: 0o700 });
    const exists = await access(join(ws.path, '.git')).then(() => true, () => false);
    if (!exists) await this.git(ws.repository, ['worktree', 'add', '--detach', '--lock', '--reason', `bridge-workflow:${ws.id}`, ws.path, checkout], ctx.signal);
    ws = { ...ws, status: 'ready' }; this.putWorkspace(ws);
    await this.binding(ctx.state.root, op.workflow, ws.id, ctx.signal);
    if ((await this.clean(ws, ctx.signal)).headCommit !== checkout) throw new Error('Recovered worktree does not match its planned revision');
    return ws;
  }

  perform(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Workspace service is closed'));
    const pending = this.performInner(ctx, input); this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  private async performInner(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<unknown> {
    const { kind, key, ...args } = input;
    const allowed: Record<string, string[]> = { create: ['base', 'change'], freeze: ['workspace'], approve: ['change', 'taskId'],
      integrate: ['base', 'approvals', 'target'], check: ['workspace', 'commands'], accept: ['workspace', 'checks'], cleanup: ['workspace'] };
    if (!Object.hasOwn(allowed, String(kind)) || Object.keys(args).some(key => !allowed[String(kind)]!.includes(key))) throw new Error('Unsupported workspace operation or option');
    const name = scriptText(key, 'workspace operation key', 100);
    if (name.startsWith('@') || name.trim() !== name) throw new Error('Invalid workspace operation key');
    const workflow = ctx.state.workflowId, lock = workflow + ':' + name;
    if (this.activeKeys.has(lock)) throw new Error('Workspace operation is already running');
    this.activeKeys.add(lock);
    try {
      ctx.signal.throwIfAborted();
      const digest = workflowDigest({ kind, args, root: ctx.state.root });
      let op = this.db.prepare('SELECT * FROM workspace_records WHERE workflow=? AND key=?').get(workflow, name) as RecordRow | undefined;
      if (op && (op.kind !== `op:${kind}` || op.digest !== digest)) throw new Error('Workspace key conflict: replay the original inputs');
      if (kind === 'approve' && !ctx.state.script?.calls.some(call => call.taskId === args.taskId)) throw new Error('Review task must belong to the current script run');
      if (op?.done) return JSON.parse(op.data);
      op ??= this.insert(workflow, name, `op:${kind}`, {}, digest, 0);
      const result = await this.apply(ctx, op, String(kind), args);
      ctx.signal.throwIfAborted(); this.save(op, result, 1); return result;
    } finally { this.activeKeys.delete(lock); }
  }

  private async apply(ctx: WorkspaceContext, op: RecordRow, kind: string, args: Record<string, unknown>): Promise<unknown> {
    const id = (value: unknown) => scriptText(value, 'artifact ID', 100);
    if (kind === 'create') {
      if (args.change !== undefined && args.base !== undefined) throw new Error('Choose base or change, not both');
      if (args.change !== undefined) {
        const change = this.value<WorkspaceChange>(id(args.change), op.workflow, 'change');
        const source = this.value<WorkspaceBinding>(change.workspaceId, op.workflow, 'workspace');
        await this.supportedTree(source.repository, change.headCommit, ctx.signal);
        return this.materialize(ctx, op, { repository: source.repository, commonDir: source.commonDir, baseCommit: change.headCommit, kind: 'review', changeId: change.id });
      }
      const prior = JSON.parse(op.data) as { repository?: string; commonDir: string; baseCommit: string };
      let seed;
      if (prior.repository) seed = { repository: prior.repository, commonDir: prior.commonDir, baseCommit: prior.baseCommit };
      else {
        const repo = await this.repository(ctx.state.root, ctx.signal);
        if ((await this.git(repo.repository, ['status', '--porcelain', '--untracked-files=all'], ctx.signal)).stdout.trim()) throw new Error('Authorized checkout has uncommitted changes; choose a clean committed baseline first');
        seed = { ...repo, baseCommit: await this.revision(repo.repository, args.base, ctx.signal) }; this.save(op, seed);
      }
      await this.supportedTree(seed.repository, seed.baseCommit, ctx.signal);
      return this.materialize(ctx, op, { ...seed, kind: 'task' });
    }
    if (kind === 'cleanup') return this.cleanup(ctx, op, id(args.workspace));
    if (kind === 'approve') {
      const change = this.value<WorkspaceChange>(id(args.change), op.workflow, 'change');
      const task = ctx.state.tasks.find(task => task.taskId === args.taskId);
      if (!task || task.status !== 'result_ready' || !task.workspaceId || !ctx.state.script?.calls.some(call => call.taskId === task.taskId)) throw new Error('Review must reference a successfully completed workspace task');
      const ws = await this.binding(ctx.state.root, op.workflow, task.workspaceId, ctx.signal); this.idle(ws, ctx);
      if (ws.kind !== 'review' || ws.changeId !== change.id || task.agentId) throw new Error('Approval requires an independent task in the matching review snapshot');
      const token = this.begin(ws);
      try {
        await this.verifySnapshot(ws, ctx.signal);
        const resultRef = task.resultRefs.at(-1)!;
        const artifact = ctx.state.artifacts.find(artifact => artifact.ref === resultRef);
        let result;
        try { result = JSON.parse(artifact?.text ?? '') as { ok?: unknown; reason?: unknown; evidence?: unknown }; } catch { throw new Error('Review result must be JSON'); }
        if (result?.ok !== true || typeof result.reason !== 'string' || !result.reason.trim()
          || !Array.isArray(result.evidence) || !result.evidence.length
          || result.evidence.some(entry => typeof entry !== 'string' || !entry.trim())) throw new Error('Independent review did not approve with evidence');
        return this.internal<WorkspaceApproval>(op, 'approval', 'approval', id => ({ id, changeId: change.id, taskId: task.taskId, resultRef }));
      } finally { this.end(ws, token); }
    }
    if (kind === 'integrate') return this.integrate(ctx, op, args);
    const ws = await this.binding(ctx.state.root, op.workflow, id(args.workspace), ctx.signal); this.idle(ws, ctx);
    const token = this.begin(ws);
    try {
      if (kind === 'freeze') {
        const pinned = await this.clean(ws, ctx.signal);
        await this.supportedTree(ws.repository, pinned.headCommit, ctx.signal);
        if ((await this.git(ws.path, ['merge-base', '--is-ancestor', ws.baseCommit, pinned.headCommit], ctx.signal, true)).code) throw new Error('Candidate no longer descends from its recorded base');
        const integration = ws.kind === 'integration' ? this.integration(ws) : undefined;
        const linearBase = integration?.headCommit ?? ws.baseCommit;
        if ((await this.git(ws.path, ['merge-base', '--is-ancestor', linearBase, pinned.headCommit], ctx.signal, true)).code) throw new Error('Repair must descend from the prepared integration');
        if ((await this.git(ws.path, ['rev-list', '--min-parents=2', `${linearBase}..${pinned.headCommit}`], ctx.signal)).stdout.trim()) throw new Error('Workspace candidates must have linear history');
        await this.git(ws.path, ['diff', '--check', ws.baseCommit, pinned.headCommit], ctx.signal);
        const diff = (await this.git(ws.path, ['diff', '--binary', ws.baseCommit, pinned.headCommit], ctx.signal)).stdout;
        const files = (await this.git(ws.path, ['diff', '--name-only', '-z', ws.baseCommit, pinned.headCommit], ctx.signal)).stdout.split('\0').filter(Boolean);
        const change = this.internal<WorkspaceChange>(op, 'change', 'change', id => ({ id, workspaceId: ws.id, baseCommit: ws.baseCommit, ...pinned, diffDigest: workflowDigest(diff), files }));
        if (change.headCommit !== pinned.headCommit) throw new Error('Workspace changed during recovery; use a new freeze key');
        await this.git(ws.repository, ['update-ref', `refs/bridge-workflow/${op.workflow}/changes/${change.id}`, change.headCommit], ctx.signal);
        return change;
      }
      if (kind === 'check') return await this.check(ctx, op, ws, args.commands);
      if (kind === 'accept') {
        const integration = this.integration(ws);
        if (integration.status !== 'prepared') throw new Error('Repair and independently review the conflict, then prepare a new integration with remaining approvals');
        const checks = this.value<WorkspaceChecks>(id(args.checks), op.workflow, 'checks');
        const pinned = await this.clean(ws, ctx.signal);
        if (!checks.passed || checks.workspaceId !== ws.id || checks.headCommit !== pinned.headCommit || checks.tree !== pinned.tree
          || pinned.headCommit !== integration.headCommit) throw new Error('Passing checks must cover the unchanged integration revision');
        const accepted = this.internal(op, 'accepted', 'accepted', id => ({ id, workspace: ws.id, checks: checks.id,
          headCommit: pinned.headCommit, branch: integration.targetRef, completed: false }));
        const current = await this.refHead(ws.repository, integration.targetRef, ctx.signal);
        if (current !== integration.expectedHead && current !== pinned.headCommit) throw new Error('Integration target advanced; prepare and validate a new integration');
        if (current !== pinned.headCommit) {
          if ((await this.git(ws.repository, ['worktree', 'list', '--porcelain'], ctx.signal)).stdout.split('\n').includes(`branch ${integration.targetRef}`)) throw new Error('Integration target is checked out; keep the checkout unchanged');
          await this.git(ws.repository, ['update-ref', integration.targetRef, pinned.headCommit, current ?? '0'.repeat(pinned.headCommit.length)], ctx.signal);
        }
        accepted.completed = true;
        this.save(this.row(accepted.id, op.workflow, 'accepted'), accepted);
        return accepted;
      }
      throw new Error('Unknown workspace operation');
    } finally { this.end(ws, token); }
  }

  private integration(ws: WorkspaceBinding): WorkspaceIntegration {
    const row = this.db.prepare("SELECT * FROM workspace_records WHERE workflow=? AND kind='integration' AND json_extract(data,'$.workspace.id')=?").get(ws.workflowId, ws.id) as RecordRow | undefined;
    if (!row) throw new Error('Only a prepared integration workspace can be accepted');
    return JSON.parse(row.data) as WorkspaceIntegration;
  }

  private async cleanup(ctx: WorkspaceContext, op: RecordRow, workspaceId: string): Promise<unknown> {
    let ws = this.value<WorkspaceBinding>(workspaceId, op.workflow, 'workspace');
    if (ws.rootDigest !== workflowDigest(ctx.state.root)) throw new Error('Workspace authorization changed');
    const intent = JSON.parse(op.data) as { removing?: boolean; token?: string };
    if (ws.status === 'removed') return { workspace: ws.id, removed: true };
    if (intent.removing && !await access(ws.path).then(() => true, () => false)) {
      if (ws.busy && ws.busy.token !== intent.token) throw new Error('Workspace execution ownership changed');
      const listed = (await this.git(ws.repository, ['worktree', 'list', '--porcelain'], ctx.signal)).stdout;
      if (listed.split('\n').includes(`worktree ${ws.path}`)) throw new Error('Missing worktree is still registered; preserve for recovery');
      this.putWorkspace({ ...ws, status: 'removed', busy: undefined });
      return { workspace: ws.id, removed: true };
    }
    this.idle(ws, ctx);
    ws = await this.binding(ctx.state.root, op.workflow, ws.id, ctx.signal);
    const token = this.begin(ws);
    try {
      const pinned = await this.clean(ws, ctx.signal);
      const accepted = this.db.prepare("SELECT 1 FROM workspace_records WHERE workflow=? AND kind='accepted' AND json_extract(data,'$.completed')=1 AND json_extract(data,'$.workspace')=? AND json_extract(data,'$.headCommit')=?").get(op.workflow, ws.id, pinned.headCommit);
      if (pinned.headCommit !== ws.baseCommit && !accepted) throw new Error('Keep workspaces with unintegrated changes');
      this.save(op, { removing: true, token });
      const unlock = await this.git(ws.repository, ['worktree', 'unlock', ws.path], ctx.signal, true);
      if (unlock.code && !unlock.stderr.includes('not locked')) throw new Error('Cannot unlock worktree');
      await this.git(ws.repository, ['worktree', 'remove', ws.path], ctx.signal);
      this.putWorkspace({ ...ws, status: 'removed', busy: { token, ownerPid: process.pid } });
      return { workspace: ws.id, removed: true };
    } finally { this.end(ws, token); }
  }

  private async refHead(repo: string, ref: string, signal: AbortSignal): Promise<string | null> {
    const value = await this.git(repo, ['rev-parse', '--verify', '--quiet', ref], signal, true);
    if (value.code === 1) return null;
    if (value.code || !SHA.test(value.stdout.trim())) throw new Error('Cannot inspect integration target ref');
    return value.stdout.trim();
  }
  private async integrate(ctx: WorkspaceContext, op: RecordRow, args: Record<string, unknown>): Promise<WorkspaceIntegration> {
    if (!Array.isArray(args.approvals) || !args.approvals.length || args.approvals.length > 16 || new Set(args.approvals).size !== args.approvals.length) throw new Error('integrateChanges needs 1–16 distinct approval IDs');
    const approvals = args.approvals.map(value => this.value<WorkspaceApproval>(scriptText(value, 'approval ID', 100), op.workflow, 'approval'));
    const changes = approvals.map(approval => this.value<WorkspaceChange>(approval.changeId, op.workflow, 'change'));
    const target = args.target === undefined ? 'result' : scriptText(args.target, 'integration target', 64);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(target)) throw new Error('Integration target must be a simple private branch name');
    const repo = await this.repository(ctx.state.root, ctx.signal);
    const targetRef = `refs/heads/bridge-workflow/${op.workflow}/${target}`;
    let plan = JSON.parse(op.data) as { baseCommit?: string; expectedHead: string | null };
    if (!plan.baseCommit) {
      const expectedHead = await this.refHead(repo.repository, targetRef, ctx.signal);
      const baseCommit = args.base === undefined && expectedHead ? expectedHead : await this.revision(repo.repository, args.base, ctx.signal);
      if (expectedHead && baseCommit !== expectedHead) throw new Error('Integration base must match its current target');
      plan = { expectedHead, baseCommit }; this.save(op, plan);
    }
    let head = plan.baseCommit!, status: WorkspaceIntegration['status'] = 'prepared', conflict: string | undefined, remaining: string[] = [];
    const identity = { GIT_AUTHOR_NAME: 'Bridge workflow', GIT_AUTHOR_EMAIL: 'workflow@localhost', GIT_COMMITTER_NAME: 'Bridge workflow', GIT_COMMITTER_EMAIL: 'workflow@localhost',
      GIT_AUTHOR_DATE: new Date(op.created).toISOString(), GIT_COMMITTER_DATE: new Date(op.created).toISOString() };
    for (const [index, change] of changes.entries()) {
      const ws = this.value<WorkspaceBinding>(change.workspaceId, op.workflow, 'workspace');
      if (ws.commonDir !== repo.commonDir) throw new Error('Integration candidates belong to another repository');
      if ((await this.git(repo.repository, ['merge-base', '--is-ancestor', change.baseCommit, head], ctx.signal, true)).code) throw new Error('Integration lacks the candidate baseline/dependencies');
      const merged = await this.git(repo.repository, ['merge-tree', '--write-tree', head, change.headCommit], ctx.signal, true);
      const tree = merged.stdout.split('\n')[0]!;
      if (![0, 1].includes(merged.code) || !SHA.test(tree)) throw new Error('Git merge-tree failed; Git 2.38 or newer is required');
      head = (await this.git(repo.repository, ['commit-tree', tree, '-p', head, ...(change.headCommit === head ? [] : ['-p', change.headCommit]), '-m', `Workflow ${op.id}: candidate ${change.id}`], ctx.signal, false, identity)).stdout.trim();
      if (merged.code) { status = 'conflict'; conflict = merged.stdout.slice(tree.length, tree.length + 8000); remaining = approvals.slice(index + 1).map(approval => approval.id); break; }
    }
    await this.supportedTree(repo.repository, head, ctx.signal);
    const workspace = await this.materialize(ctx, op, { ...repo, baseCommit: plan.baseCommit!, kind: 'integration' }, head);
    return this.internal<WorkspaceIntegration>(op, 'integration', 'integration', () => ({ workspace, status,
      approvals: approvals.map(approval => approval.id), remaining, targetRef, expectedHead: plan.expectedHead, headCommit: head, ...(conflict ? { conflict } : {}) }));
  }

  private async check(ctx: WorkspaceContext, op: RecordRow, ws: WorkspaceBinding, value: unknown): Promise<WorkspaceChecks> {
    if (!Array.isArray(value) || !value.length || value.length > 4) throw new Error('Checks require 1–4 foreground commands');
    const commands = value.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid check command');
      const item = raw as Record<string, unknown>;
      if (Object.keys(item).some(key => !['argv', 'timeoutMs'].includes(key)) || !Array.isArray(item.argv) || !item.argv.length || item.argv.length > 64) throw new Error('Check commands require an argv array');
      return { argv: item.argv.map(arg => scriptText(arg, 'command argument', 4000)), timeoutMs: boundedInteger(item.timeoutMs, 300_000, 100, 1_800_000) };
    });
    const pinned = await this.clean(ws, ctx.signal);
    const results: WorkspaceChecks['commands'] = [];
    for (const command of commands) {
      const result = await workspaceCommand(command.argv[0]!, command.argv.slice(1), ws.path, ctx.signal,
        Math.max(1, Math.min(command.timeoutMs, ctx.state.deadlineAt - Date.now())), gitEnv(), this.processes);
      results.push({ argv: command.argv, code: result.code, stdout: result.stdout.slice(-16000), stderr: result.stderr.slice(-16000) });
      if (result.code) break;
    }
    const after = await this.clean(ws, ctx.signal);
    const passed = results.length === commands.length && results.every(result => result.code === 0) && after.headCommit === pinned.headCommit && after.tree === pinned.tree;
    return this.internal<WorkspaceChecks>(op, 'checks', 'checks', id => ({ id, workspaceId: ws.id, ...pinned, passed, commands: results }));
  }

  async close(): Promise<void> {
    this.closed = true; await Promise.allSettled([...this.pending]); this.db.close();
  }
}
