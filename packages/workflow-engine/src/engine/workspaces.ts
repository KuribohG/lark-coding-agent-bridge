import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { access, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { workflowDigest } from './digest';
import { MAX_WORKSPACES, MAX_WORKSPACE_RECORDS, WORKSPACE_CHECKOUT_SLOTS } from './limits';
import { boundedInteger, scriptText } from './script-contract';
import { nodeProcesses, workspaceCommand, type CommandResult } from './workspace-process';
import type { WorkflowProcesses } from './ports';
import type { LandingChange, LandingHead, LandingOverride, LandingRefusal, LandingView, LandReport, WorkspaceApproval, WorkspaceBinding, WorkspaceChange, WorkspaceChecks, WorkspaceCommands, WorkspaceContext, WorkspaceIntegration, WorkspaceLanding } from './workspace-types';
import type { WorkflowRoot } from './types';

interface RecordRow { id: string; workflow: string; key: string; kind: string; digest: string; done: number; data: string; created: number }
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const BUSY = new Set(['queued', 'starting', 'running', 'cancelling', 'waiting_workflow']);
// Git registers a new worktree in several steps. Concurrent commands can observe a partial entry.
const worktreeCommands = new Map<string, Promise<CommandResult>>();
/** The checkout a clone was made from, as the clone's remote. */
export const CLONE_REMOTE = 'bridge-source';
/** Where a clone offers the commit the source is about to fetch. */
const CLONE_PUBLISH_REF = 'refs/bridge-workflow/publish';
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });

/** A counting semaphore: callers beyond the bound wait for a free slot instead of all running at once. */
class Slots {
  private free: number;
  private readonly waiting: Array<{ grant: () => void; cancel: () => void }> = [];
  constructor(size: number) { this.free = size; }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.grant(); else this.free++;
    };
    if (this.free > 0) { this.free--; return release; }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        grant: () => { signal.removeEventListener('abort', abort); resolve(release); },
        cancel: () => { const at = this.waiting.indexOf(waiter); if (at >= 0) this.waiting.splice(at, 1); reject(signal.reason); },
      };
      const abort = () => waiter.cancel();
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(waiter);
    });
  }
}
/** Writing a fresh worktree touches every file in the checkout, so it runs in a bounded pool shared by all workflows. */
const checkoutSlots = new Slots(WORKSPACE_CHECKOUT_SLOTS);

/** A submission waiting for a train: the member's commits `base..head`, already rebased onto the branch as it was then. */
interface Candidate { ws: WorkspaceBinding; base: string; head: string; commits: number; ctx: WorkspaceContext; resolve(report: LandReport): void; reject(error: unknown): void }
type CheckFailure = { commands: WorkspaceChecks['commands']; reason?: string };

/**
 * A protected path pattern, anchored at the repository root: `*` and `?` stay inside one path segment, `**` crosses
 * them, and a pattern that names a directory covers everything below it.
 */
function pathPattern(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*|\?/g, token => token === '**/' ? '(?:.*/)?' : token === '**' ? '.*' : token === '*' ? '[^/]*' : '[^/]');
  return new RegExp(`^${body}${glob.endsWith('/') ? '.*' : '(?:/.*)?'}$`);
}
const tail = (results: WorkspaceChecks['commands']) => results.map(result => ({ ...result, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) }));
/** The main agent's changes to the landing, kept apart from the script's configuration in `@landing`. */
const LANDING_OVERRIDE = '@landing-override';
const short = (commit: string | null) => commit ? commit.slice(0, 10) : 'no commit';

/** The journal precedes Git/filesystem operations. Successful results are immutable on replay. */
export class WorkflowWorkspaces {
  private readonly db: Database.Database;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly activeKeys = new Set<string>();
  /** Submissions waiting to land, for each workflow and repository; one train at a time runs on each. */
  private readonly trains = new Map<string, { queue: Candidate[]; running: boolean }>();
  /** Stops the trains when the service closes. */
  private readonly stopping = new AbortController();
  /** The last piece of work that uses each train's worktree; a train and a trial of new checks take turns there. */
  private readonly tracks = new Map<string, Promise<unknown>>();
  /** What the main agent has yet to hear about each train's branch; it travels with the next reports. */
  private readonly unsaid = new Map<string, string>();
  /** The landing in progress in each worktree; a repeated submission joins it. */
  private readonly inFlight = new Map<string, Promise<LandReport>>();
  /** Commits whose tree this service already screened for submodules and checkout filters, one check per commit. */
  private readonly supported = new Map<string, Promise<void>>();
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
    if (count >= MAX_WORKSPACE_RECORDS) throw new Error('Workspace artifact budget reached');
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
  /** A record the service keeps under a reserved key of its own, such as the landing configuration. */
  private record<T>(workflow: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT * FROM workspace_records WHERE workflow=? AND key=?').get(workflow, key) as RecordRow | undefined;
    return row && JSON.parse(row.data) as T;
  }
  private put(workflow: string, key: string, kind: string, value: unknown): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM workspace_records WHERE workflow=? AND key=?').get(workflow, key) as RecordRow | undefined;
      if (row) this.save(row, value); else this.insert(workflow, key, kind, value);
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
  private async worktree(ws: Pick<WorkspaceBinding, 'repository' | 'commonDir'>, args: string[], signal: AbortSignal, allowFailure = false): Promise<CommandResult> {
    const previous = worktreeCommands.get(ws.commonDir) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => {
      signal.throwIfAborted();
      return this.git(ws.repository, ['worktree', ...args], signal, allowFailure);
    });
    worktreeCommands.set(ws.commonDir, pending);
    try {
      return await pending;
    } finally {
      if (worktreeCommands.get(ws.commonDir) === pending) worktreeCommands.delete(ws.commonDir);
    }
  }
  private async revision(repo: string, value: unknown, signal: AbortSignal): Promise<string> {
    if (value !== undefined && (typeof value !== 'string' || !SHA.test(value))) throw new Error('Workspace base must be a full commit ID');
    const head = (await this.git(repo, ['rev-parse', '--verify', `${value ?? 'HEAD'}^{commit}`], signal)).stdout.trim();
    if (!SHA.test(head)) throw new Error('Invalid repository revision');
    return head;
  }
  /** The tree at `head` does not change, so a commit is screened once however many worktrees are made from it. */
  private async supportedTree(repo: string, head: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const key = `${repo}\0${head}`;
    const known = this.supported.get(key);
    if (known) return known;
    const screen = this.screenTree(repo, head, signal).catch(error => { this.supported.delete(key); throw error; });
    this.supported.set(key, screen);
    if (this.supported.size > 512) this.supported.delete(this.supported.keys().next().value!);
    return screen;
  }
  private async screenTree(repo: string, head: string, signal: AbortSignal): Promise<void> {
    const tree = (await this.git(repo, ['ls-tree', '-r', '-z', head], signal)).stdout;
    if (tree.split('\0').some(entry => entry.startsWith('160000 '))) throw new Error('Workspace v1 does not support submodules');
    const attributes = tree.split('\0').map(line => line.slice(line.indexOf('\t') + 1)).filter(path => path === '.gitattributes' || path.endsWith('/.gitattributes'));
    for (const path of attributes) {
      const text = (await this.git(repo, ['show', `${head}:${path}`], signal)).stdout;
      if (/\bfilter\s*=/.test(text)) throw new Error('Workspace v1 does not support checkout filters or Git LFS');
    }
  }
  /** The checkout worktrees are made from: the workflow's cwd, or the root of another checkout the script names. */
  private async repository(root: WorkflowRoot, signal: AbortSignal, repo?: unknown): Promise<{ repository: string; commonDir: string }> {
    const start = repo === undefined ? root.cwdRealpath : scriptText(repo, 'repository path', 1024);
    if (!isAbsolute(start)) throw new Error('repo must be an absolute path');
    const repository = await realpath((await this.git(start, ['rev-parse', '--show-toplevel'], signal)).stdout.trim());
    if (repository !== await realpath(start)) throw new Error(repo === undefined ? 'Workspace operations require the authorized repository root as cwd, or a repo option' : 'repo must be the root of a Git checkout');
    const commonDir = await realpath(resolve(repository, (await this.git(repository, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()));
    return { repository, commonDir };
  }

  async binding(root: WorkflowRoot, workflowId: string, id: string, signal: AbortSignal): Promise<WorkspaceBinding> {
    const ws = this.value<WorkspaceBinding>(id, workflowId, 'workspace');
    if (ws.rootDigest !== workflowDigest(root) || ws.status !== 'ready') throw new Error('Workspace binding is unavailable or authorization changed');
    const top = await realpath((await this.git(ws.path, ['rev-parse', '--show-toplevel'], signal)).stdout.trim());
    const common = await realpath(resolve(ws.path, (await this.git(ws.path, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()));
    if (top !== await realpath(ws.path) || common !== (ws.isolation === 'clone' ? join(top, '.git') : ws.commonDir)
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

  private async materialize(ctx: WorkspaceContext, op: RecordRow, seed: { repository: string; commonDir: string; baseCommit: string; kind: WorkspaceBinding['kind']; isolation?: 'clone'; changeId?: string }, checkout = seed.baseCommit): Promise<WorkspaceBinding> {
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE workflow=? AND kind='workspace'").get(op.workflow) as { n: number }).n;
    const existing = this.db.prepare('SELECT id FROM workspace_records WHERE workflow=? AND key=?').get(op.workflow, `@${op.id}/workspace`);
    if (!existing && count >= MAX_WORKSPACES) throw new Error(`Workspace budget reached (${MAX_WORKSPACES} per workflow)`);
    let ws = this.internal<WorkspaceBinding>(op, 'workspace', 'workspace', id => ({ id, workflowId: op.workflow,
      rootDigest: workflowDigest(ctx.state.root), path: join(resolve(this.directory), op.workflow, id), status: 'preparing', ...seed }));
    if (ws.status === 'removed') throw new Error('Workspace was removed; use a new workspace key');
    if (ws.status === 'ready') {
      const bound = await this.binding(ctx.state.root, op.workflow, ws.id, ctx.signal);
      if ((await this.clean(bound, ctx.signal)).headCommit !== checkout) throw new Error('Recovered worktree does not match its planned revision');
      return bound;
    }
    await mkdir(dirname(ws.path), { recursive: true, mode: 0o700 });
    if (ws.isolation === 'clone') await this.clone(ws, checkout, ctx.signal);
    else {
      const exists = await access(join(ws.path, '.git')).then(() => true, () => false);
      // Only registration races with other Git commands; leave `worktree add` cheap and write the files separately.
      if (!exists) await this.worktree(ws, ['add', '--no-checkout', '--detach', '--lock', '--reason', `bridge-workflow:${ws.id}`, ws.path, checkout], ctx.signal);
    }
    await this.writeTree(ws.path, checkout, ctx.signal);
    ws = { ...ws, status: 'ready' }; this.putWorkspace(ws);
    await this.binding(ctx.state.root, op.workflow, ws.id, ctx.signal);
    if ((await this.clean(ws, ctx.signal)).headCommit !== checkout) throw new Error('Recovered worktree does not match its planned revision');
    return ws;
  }

  private cloneRef(ws: Pick<WorkspaceBinding, 'workflowId' | 'id'>): string { return `refs/bridge-workflow/${ws.workflowId}/clones/${ws.id}`; }
  /**
   * Makes a repository of the member's own at `ws.path`: its refs, index, stash, locks and config are separate from
   * the source checkout and from every other member, so no Git command of one can disturb another. Objects are not
   * copied: the clone reads the source's through alternates, and the source keeps a ref on what the clone was made
   * from, so that stays reachable there. The clone starts detached at `checkout`, with the source as the remote
   * CLONE_REMOTE and the source's own remotes and their remote-tracking refs under their names.
   */
  private async clone(ws: WorkspaceBinding, checkout: string, signal: AbortSignal): Promise<void> {
    // A clone that is still being prepared holds no work; one a crash left half-made is made again.
    await this.removeClone(ws);
    await this.git(ws.repository, ['update-ref', this.cloneRef(ws), checkout], signal);
    await this.git(ws.repository, ['clone', '--quiet', '--shared', '--no-checkout', '--origin', CLONE_REMOTE, ws.repository, ws.path], signal);
    await this.git(ws.path, ['update-ref', '--no-deref', 'HEAD', checkout], signal);
    for (const key of ['user.name', 'user.email']) {
      const value = (await this.git(ws.repository, ['config', key], signal, true)).stdout.trim();
      if (value) await this.git(ws.path, ['config', key, value], signal);
    }
    const remotes = (await this.git(ws.repository, ['config', '--local', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl|fetch)$'], signal, true)).stdout
      .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('\n')), entry.slice(entry.indexOf('\n') + 1)] as const)
      .filter(([key]) => key.slice('remote.'.length, key.lastIndexOf('.')) !== CLONE_REMOTE);
    for (const [key, value] of remotes) await this.git(ws.path, ['config', '--add', key, value], signal);
    if (remotes.length) await this.git(ws.path, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', CLONE_REMOTE,
      '+refs/remotes/*:refs/remotes/*', `^refs/remotes/${CLONE_REMOTE}/*`], signal);
  }
  /** Deletes a clone's directory; the path is the one this service derives for the workspace, never one read back. */
  private async removeClone(ws: WorkspaceBinding): Promise<void> {
    if (ws.isolation !== 'clone' || ws.path !== join(resolve(this.directory), ws.workflowId, ws.id)) throw new Error('Not a managed clone');
    await rm(ws.path, { recursive: true, force: true, maxRetries: 3 });
  }
  /**
   * A clone's commits are in its own object store. Before the source refers to one (a frozen change, a landing),
   * this copies it there and checks the source received the commit that was asked for.
   */
  private async publish(ws: WorkspaceBinding, head: string, signal: AbortSignal): Promise<void> {
    if (ws.isolation !== 'clone') return;
    await this.git(ws.path, ['update-ref', CLONE_PUBLISH_REF, head], signal);
    await this.git(ws.repository, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', ws.path, `+${CLONE_PUBLISH_REF}:${this.cloneRef(ws)}`], signal);
    if (await this.refHead(ws.repository, this.cloneRef(ws), signal) !== head) throw new Error('Clone changed while its commits were copied to the source repository');
  }

  /**
   * Writes a registered worktree's files. `read-tree --reset -u` uses the same checkout machinery as `worktree add`,
   * so filters and modes match, and repeating it on a worktree whose files are already there changes nothing.
   */
  private async writeTree(path: string, commit: string, signal: AbortSignal): Promise<void> {
    const release = await checkoutSlots.acquire(signal);
    try { await this.git(path, ['read-tree', '--reset', '-u', commit], signal); } finally { release(); }
  }

  perform(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Workspace service is closed'));
    const pending = this.performInner(ctx, input); this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  private async performInner(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<unknown> {
    const { kind, key, ...args } = input;
    const allowed: Record<string, string[]> = { create: ['base', 'change', 'repo', 'isolation'], freeze: ['workspace'], approve: ['change', 'taskId'],
      integrate: ['base', 'approvals', 'target'], landing: ['checks', 'target', 'precheck', 'protect', 'batch'], check: ['workspace', 'commands'], accept: ['workspace', 'checks'], cleanup: ['workspace'] };
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
      if (args.change !== undefined && (args.base !== undefined || args.repo !== undefined || args.isolation !== undefined)) throw new Error('Choose base, repo and isolation, or change');
      if (args.isolation !== undefined && args.isolation !== 'worktree' && args.isolation !== 'clone') throw new Error('isolation is "worktree" or "clone"');
      const isolation = args.isolation === 'clone' ? { isolation: 'clone' as const } : {};
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
        const repo = await this.repository(ctx.state.root, ctx.signal, args.repo);
        if ((await this.git(repo.repository, ['status', '--porcelain', '--untracked-files=all'], ctx.signal)).stdout.trim()) throw new Error('Authorized checkout has uncommitted changes; choose a clean committed baseline first');
        // A clone reads the source's objects from disk; ones a partial clone would fetch on demand are not there.
        if (isolation.isolation && (await this.git(repo.repository, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], ctx.signal, true)).stdout.trim()) throw new Error('Clone workspaces do not support partial-clone repositories');
        seed = { ...repo, baseCommit: await this.revision(repo.repository, args.base, ctx.signal) }; this.save(op, seed);
      }
      await this.supportedTree(seed.repository, seed.baseCommit, ctx.signal);
      return this.materialize(ctx, op, { ...seed, kind: 'task', ...isolation });
    }
    if (kind === 'cleanup') return this.cleanup(ctx, op, id(args.workspace));
    if (kind === 'landing') {
      const precheck = args.precheck === undefined ? undefined : this.commands(args.precheck), protect = this.protect(args.protect);
      const landing: WorkspaceLanding = { targetRef: this.targetRef(op.workflow, args.target), commands: this.commands(args.checks),
        ...(precheck ? { precheck } : {}), ...(protect ? { protect } : {}), batch: boundedInteger(args.batch, 16, 1, 64) };
      this.put(op.workflow, '@landing', 'landing', landing);
      return landing;
    }
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
        await this.publish(ws, pinned.headCommit, ctx.signal);
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
          await this.notCheckedOut(ws, integration.targetRef, ctx.signal);
          await this.git(ws.repository, ['update-ref', '-m', `bridge-workflow: accepted integration ${accepted.id}`, integration.targetRef, pinned.headCommit, current ?? '0'.repeat(pinned.headCommit.length)], ctx.signal);
          // A script may integrate onto the branch that members also land on: the queue vouches for this commit too.
          if (this.record<LandingHead>(op.workflow, this.headKey(ws.commonDir))?.targetRef === integration.targetRef) this.putHead(ws, { targetRef: integration.targetRef, head: pinned.headCommit });
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
    // A clone whose removal was interrupted may be half deleted; nothing in it is needed, so the removal is finished.
    if (intent.removing && (ws.isolation === 'clone' || !await access(ws.path).then(() => true, () => false))) {
      if (ws.busy && ws.busy.token !== intent.token) throw new Error('Workspace execution ownership changed');
      if (ws.isolation === 'clone') await this.dropClone(ws, ctx.signal);
      else {
        const listed = (await this.worktree(ws, ['list', '--porcelain'], ctx.signal)).stdout;
        if (listed.split('\n').includes(`worktree ${ws.path}`)) throw new Error('Missing worktree is still registered; preserve for recovery');
      }
      this.putWorkspace({ ...ws, status: 'removed', busy: undefined });
      return { workspace: ws.id, removed: true };
    }
    this.idle(ws, ctx);
    ws = await this.binding(ctx.state.root, op.workflow, ws.id, ctx.signal);
    const token = this.begin(ws);
    try {
      const pinned = await this.clean(ws, ctx.signal);
      const accepted = this.db.prepare("SELECT 1 FROM workspace_records WHERE workflow=? AND kind='accepted' AND json_extract(data,'$.completed')=1 AND json_extract(data,'$.workspace')=? AND json_extract(data,'$.headCommit')=?").get(op.workflow, ws.id, pinned.headCommit);
      const target = await this.landedHead(op.workflow, ws.repository, ctx.signal);
      const landed = target && !(await this.git(ws.path, ['merge-base', '--is-ancestor', pinned.headCommit, target], ctx.signal, true)).code;
      if (pinned.headCommit !== ws.baseCommit && !accepted && !landed) throw new Error('Keep workspaces with unintegrated changes');
      this.save(op, { removing: true, token });
      if (ws.isolation === 'clone') await this.dropClone(ws, ctx.signal);
      else {
        const unlock = await this.worktree(ws, ['unlock', ws.path], ctx.signal, true);
        if (unlock.code && !unlock.stderr.includes('not locked')) throw new Error('Cannot unlock worktree');
        await this.worktree(ws, ['remove', ws.path], ctx.signal);
      }
      this.putWorkspace({ ...ws, status: 'removed', busy: { token, ownerPid: process.pid } });
      if (ws.kind === 'task') await this.retireTrain(ws, ctx.signal);
      return { workspace: ws.id, removed: true };
    } finally { this.end(ws, token); }
  }

  /** Removes a clone and the source's ref on it. What the clone landed or froze is held by other refs. */
  private async dropClone(ws: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    await this.removeClone(ws);
    await this.git(ws.repository, ['update-ref', '-d', this.cloneRef(ws)], signal, true);
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
    const repo = await this.repository(ctx.state.root, ctx.signal);
    const targetRef = this.targetRef(op.workflow, args.target);
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

  private targetRef(workflow: string, value: unknown): string {
    const target = value === undefined ? 'result' : scriptText(value, 'integration target', 64);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(target)) throw new Error('Integration target must be a simple private branch name');
    return `refs/heads/bridge-workflow/${workflow}/${target}`;
  }
  private async notCheckedOut(ws: WorkspaceBinding, ref: string, signal: AbortSignal): Promise<void> {
    if ((await this.worktree(ws, ['list', '--porcelain'], signal)).stdout.split('\n').includes(`branch ${ref}`)) throw new Error('Integration target is checked out; keep the checkout unchanged');
  }
  private protect(value: unknown): WorkspaceLanding['protect'] {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error('protect takes 1–16 rules');
    return value.map(raw => {
      const rule = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
      if (Object.keys(rule).some(key => !['paths', 'allow'].includes(key)) || !Array.isArray(rule.paths) || !rule.paths.length || rule.paths.length > 64
        || rule.allow !== undefined && (!Array.isArray(rule.allow) || rule.allow.length > MAX_WORKSPACES)) throw new Error('A protect rule is {paths:[1–64 patterns], allow?:[workspace IDs]}');
      const paths = rule.paths.map(path => scriptText(path, 'protected path', 400));
      if (paths.some(path => path.startsWith('/') || path.split('/').includes('..'))) throw new Error('Protected paths are relative to the repository root');
      return { paths, allow: ((rule.allow ?? []) as unknown[]).map(id => scriptText(id, 'workspace ID', 100)) };
    });
  }
  private commands(value: unknown): WorkspaceCommands {
    if (!Array.isArray(value) || !value.length || value.length > 4) throw new Error('Checks require 1–4 foreground commands');
    return value.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid check command');
      const item = raw as Record<string, unknown>;
      if (Object.keys(item).some(key => !['argv', 'timeoutMs'].includes(key)) || !Array.isArray(item.argv) || !item.argv.length || item.argv.length > 64) throw new Error('Check commands require an argv array');
      return { argv: item.argv.map(arg => scriptText(arg, 'command argument', 4000)), timeoutMs: boundedInteger(item.timeoutMs, 300_000, 100, 1_800_000) };
    });
  }
  /** Runs the commands in order in the directory and stops at the first failure. */
  private async run(path: string, commands: WorkspaceCommands, signal: AbortSignal, deadlineAt: number): Promise<WorkspaceChecks['commands']> {
    const results: WorkspaceChecks['commands'] = [];
    for (const command of commands) {
      const result = await workspaceCommand(command.argv[0]!, command.argv.slice(1), path, signal,
        Math.max(1, Math.min(command.timeoutMs, deadlineAt - Date.now())), gitEnv(), this.processes);
      results.push({ argv: command.argv, code: result.code, stdout: result.stdout.slice(-16000), stderr: result.stderr.slice(-16000) });
      if (result.code) break;
    }
    return results;
  }

  /** How members land their work, once the script has called configureLanding: its configuration with the main agent's changes. */
  landing(workflow: string): WorkspaceLanding | undefined {
    const base = this.record<WorkspaceLanding>(workflow, '@landing');
    return base && this.effective(base, this.record<LandingOverride>(workflow, LANDING_OVERRIDE) ?? {});
  }
  private effective(base: WorkspaceLanding, over: LandingOverride): WorkspaceLanding {
    const precheck = over.precheck ? over.precheck.length ? over.precheck : undefined : base.precheck;
    const protect = [...base.protect ?? [], ...over.protect ?? []];
    return { targetRef: base.targetRef, commands: over.commands ?? base.commands, ...(precheck ? { precheck } : {}),
      ...(protect.length ? { protect } : {}), batch: over.batch ?? base.batch };
  }
  private async landedHead(workflow: string, repo: string, signal: AbortSignal): Promise<string | null> {
    const landing = this.landing(workflow);
    return landing ? this.refHead(repo, landing.targetRef, signal) : null;
  }
  /**
   * Lands the commits of a member's worktree on the landing branch. Called by the task running in that worktree,
   * which waits for the answer. The worktree is rebased onto the branch, screened for protected paths and prechecked
   * on its own, side by side with other members; then the submission boards the next train (see `round`).
   */
  land(ctx: WorkspaceContext, input: { workspace: string; taskId: string }): Promise<LandReport> {
    if (this.closed) return Promise.reject(new Error('Workspace service is closed'));
    const key = `${ctx.state.workflowId}:${input.workspace}:${input.taskId}`;
    const joined = this.inFlight.get(key);
    if (joined) return joined;
    const pending = this.landInner(ctx, input); this.pending.add(pending); this.inFlight.set(key, pending);
    void pending.finally(() => { this.pending.delete(pending); this.inFlight.delete(key); }).catch(() => {});
    return pending;
  }
  private async landInner(ctx: WorkspaceContext, input: { workspace: string; taskId: string }): Promise<LandReport> {
    const workflow = ctx.state.workflowId, { signal } = ctx;
    const landing = this.landing(workflow);
    if (!landing) throw new Error('Landing is not configured; the script calls configureLanding first');
    const ws = await this.binding(ctx.state.root, workflow, input.workspace, signal);
    if (ws.kind !== 'task') throw new Error('Only task workspaces can be landed');
    if (ws.busy?.taskId !== input.taskId) throw new Error('Landing requires the task that is running in this worktree');
    const { targetRef } = landing;
    const ancestor = async (older: string, newer: string) => !(await this.git(ws.path, ['merge-base', '--is-ancestor', older, newer], signal, true)).code;
    const before = await this.clean(ws, signal);
    let branch = await this.refHead(ws.repository, targetRef, signal);
    // A branch the queue does not vouch for is looked at before the member's commits are rebased onto it.
    if ((this.vouched(ws, targetRef, branch)?.head ?? branch) !== branch) {
      const verdict = await this.exclusive(this.trainKey(ws), () => this.inspect(landing, ws, ctx.state.deadlineAt));
      if (verdict.halt) return this.halted(targetRef, verdict);
      branch = verdict.head;
    }
    const targetCommit = branch ?? ws.baseCommit;
    const nothing = { status: 'landed' as const, targetRef, headCommit: targetCommit, commits: 0 };
    if (await ancestor(before.headCommit, targetCommit)) return nothing;
    if (!await ancestor(targetCommit, before.headCommit)) {
      const undo = () => this.git(ws.path, ['rebase', '--abort'], new AbortController().signal, true);
      const rebased = await this.git(ws.path, [...await this.identity(ws.path, signal), 'rebase', targetCommit], signal, true).catch(async error => { await undo(); throw error; });
      if (rebased.code) await undo();
      if (rebased.code) return { status: 'conflict', targetRef, targetCommit, detail: (rebased.stdout + rebased.stderr).slice(-4000) };
    }
    const pinned = await this.clean(ws, signal);
    if (pinned.headCommit === targetCommit) return nothing;
    if (landing.protect) {
      const changed = (await this.git(ws.path, ['diff', '--name-only', '--no-renames', '-z', targetCommit, pinned.headCommit], signal)).stdout.split('\0').filter(Boolean);
      const barred = landing.protect.filter(rule => !rule.allow.includes(ws.id)).flatMap(rule => rule.paths.map(pathPattern));
      const files = changed.filter(file => barred.some(pattern => pattern.test(file)));
      if (files.length) return { status: 'rejected', targetRef, targetCommit, files: files.slice(0, 64),
        reason: `${files.length} changed path(s) are protected from this worktree; resubmit commits that leave them as they are on the landing branch` };
    }
    if (landing.precheck) {
      const commands = tail(await this.run(ws.path, landing.precheck, signal, ctx.state.deadlineAt));
      const failed = { status: 'check_failed' as const, targetRef, targetCommit, headCommit: pinned.headCommit, commands };
      if (commands.length !== landing.precheck.length || commands.some(result => result.code)) return failed;
      const after = await this.clean(ws, signal).catch((error: Error) => error.message);
      if (typeof after === 'string') return { ...failed, reason: after };
      if (after.headCommit !== pinned.headCommit) return { ...failed, reason: 'Checks changed the worktree HEAD' };
    }
    const commits = Number((await this.git(ws.path, ['rev-list', '--count', `${targetCommit}..${pinned.headCommit}`], signal)).stdout.trim());
    await this.publish(ws, pinned.headCommit, signal);
    const report = await this.board({ ws, base: targetCommit, head: pinned.headCommit, commits, ctx });
    // The train restacked the commits: bring the worktree to where the report says they are, unless the member moved it meanwhile.
    if ((report.status === 'landed' || report.status === 'check_failed') && report.headCommit !== pinned.headCommit) {
      const quiet = new AbortController().signal;
      const now = await this.clean(ws, quiet).catch(() => undefined);
      if (now?.headCommit === pinned.headCommit) await this.git(ws.path, ['reset', '--hard', '--quiet', report.headCommit], quiet, true);
    }
    return report;
  }
  private async identity(path: string, signal: AbortSignal): Promise<string[]> {
    return (await this.git(path, ['config', 'user.email'], signal, true)).stdout.trim() ? [] : ['-c', 'user.name=Bridge workflow', '-c', 'user.email=workflow@localhost'];
  }

  /** Queues a submission for the next train of its workflow and repository; settles when a train has dealt with it. */
  private board(change: Omit<Candidate, 'resolve' | 'reject'>): Promise<LandReport> {
    const key = `${change.ws.workflowId}:${change.ws.commonDir}`, { signal } = change.ctx;
    const train = this.trains.get(key) ?? { queue: [], running: false }, { queue } = train;
    this.trains.set(key, train);
    return new Promise<LandReport>((resolve, reject) => {
      // A member whose turn ended leaves the queue; once on a train its work lands or fails with the rest.
      const leave = () => { const at = queue.indexOf(candidate); if (at >= 0) { queue.splice(at, 1); reject(signal.reason); } };
      const settled = <T>(settle: (value: T) => void) => (value: T) => { signal.removeEventListener('abort', leave); settle(value); };
      const candidate: Candidate = { ...change, resolve: settled(resolve), reject: settled(reject) };
      signal.addEventListener('abort', leave, { once: true });
      queue.push(candidate);
      if (!train.running) {
        train.running = true;
        const driving = this.drive(key, train); this.pending.add(driving);
        void driving.finally(() => this.pending.delete(driving));
      }
    });
  }
  private async drive(key: string, train: { queue: Candidate[]; running: boolean }): Promise<void> {
    while (train.queue.length && !this.closed) {
      // The landing is read once the worktree is free: a change the main agent made meanwhile applies to this train.
      await this.exclusive(key, async () => {
        if (!train.queue.length) return;
        const landing = this.landing(train.queue[0]!.ws.workflowId);
        const batch = train.queue.splice(0, landing?.batch ?? train.queue.length);
        try {
          if (!landing) throw new Error('Landing is not configured; the script calls configureLanding first');
          train.queue.unshift(...await this.round(landing, batch));
        } catch (error) { for (const candidate of batch) candidate.reject(error); }
      });
    }
    for (const candidate of train.queue.splice(0)) candidate.reject(this.stopping.signal.reason);
    train.running = false;
    if (this.trains.get(key) === train) this.trains.delete(key);
  }

  /** Runs `work` once everything queued before it for the same train's worktree has finished. */
  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const turn = (this.tracks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.tracks.set(key, turn);
    void turn.catch(() => undefined).finally(() => { if (this.tracks.get(key) === turn) this.tracks.delete(key); });
    return turn;
  }
  private trainKey(ws: Pick<WorkspaceBinding, 'workflowId' | 'commonDir'>): string { return `${ws.workflowId}:${ws.commonDir}`; }
  private headKey(commonDir: string): string { return `@landing-head/${workflowDigest(commonDir).slice(0, 16)}`; }
  private putHead(ws: Pick<WorkspaceBinding, 'workflowId' | 'commonDir'>, head: LandingHead): void {
    this.put(ws.workflowId, this.headKey(ws.commonDir), 'landing-head', head);
  }
  /** The commit the queue vouches for on a repository's landing branch, once it has landed or adopted one. */
  private vouched(ws: Pick<WorkspaceBinding, 'workflowId' | 'commonDir'>, targetRef: string, current: string | null): LandingHead | undefined {
    const known = this.record<LandingHead>(ws.workflowId, this.headKey(ws.commonDir));
    if (!known || known.targetRef !== targetRef) return undefined;
    // The move this record announced was made; the service stopped before it could say so.
    if (known.next && known.next === current) { const settled = { targetRef, head: current }; this.putHead(ws, settled); return settled; }
    return known;
  }
  /** Moves the landing branch from `expected` to `head`, with a reflog entry that names the queue, and vouches for `head`. */
  private async advance(ws: WorkspaceBinding, targetRef: string, head: string, expected: string | null, message: string, signal: AbortSignal): Promise<void> {
    const known = this.record<LandingHead>(ws.workflowId, this.headKey(ws.commonDir));
    if (expected) this.putHead(ws, { targetRef, head: expected, next: head });
    try {
      await this.git(ws.repository, ['update-ref', '-m', message, targetRef, head, expected ?? '0'.repeat(head.length)], signal);
    } catch (error) {
      if (expected && known) this.putHead(ws, known);
      throw error;
    }
    this.putHead(ws, { targetRef, head });
  }
  private async park(path: string, commit: string, signal: AbortSignal): Promise<void> {
    await this.git(path, ['reset', '--hard', '--quiet', commit], signal);
    await this.git(path, ['clean', '-fd', '--quiet'], signal);
  }
  /**
   * Where the landing branch is, once the queue vouches for it or has halted on it. Runs with the train's worktree to
   * itself. A branch the queue has no record of is taken as it is.
   */
  private async inspect(landing: WorkspaceLanding, ws: WorkspaceBinding, deadlineAt: number): Promise<{ head: string | null; halt?: string; notice?: string }> {
    const { signal } = this.stopping, { targetRef } = landing;
    const head = await this.refHead(ws.repository, targetRef, signal);
    const known = this.vouched(ws, targetRef, head);
    if (!known) { if (head) this.putHead(ws, { targetRef, head }); return { head }; }
    if (known.head === head) { if (known.halt) this.putHead(ws, { targetRef, head }); return { head }; }
    const verdict = await this.vet(landing, ws, await this.trainWorktree(ws, signal), known, head, deadlineAt, signal);
    if (!verdict.halt) this.unsaid.set(this.trainKey(ws), verdict.notice);
    return { head, ...verdict };
  }
  private halted(targetRef: string, verdict: { head: string | null; halt?: string; notice?: string }): LandReport {
    return { status: 'halted', targetRef, targetCommit: verdict.head, ...(verdict.notice ? { notice: verdict.notice } : {}),
      reason: `The landing branch was moved from outside the landing queue and ${verdict.halt}. Nothing lands until the main agent settles it, and it has been told: keep your commits, do not submit again in this turn and do not move the branch yourself.` };
  }
  /**
   * The branch is not where the queue left it. Commits that were added on top of it, leave every protected path
   * alone and pass the precheck and the checks are as good as landed ones, and the queue vouches for them from here
   * on. Anything else halts the landing until the main agent restores or adopts the branch (configure_landing).
   */
  private async vet(landing: WorkspaceLanding, ws: WorkspaceBinding, path: string, known: LandingHead, current: string | null, deadlineAt: number, signal: AbortSignal): Promise<{ halt?: string; notice: string }> {
    const { targetRef } = landing;
    const stopped = (reason: string) => ({ halt: reason, notice: `落地已停止：落地分支 ${targetRef} 被队列外改动（队列上次落地在 ${short(known.head)}，现在是 ${short(current)}），不能自动接纳：${reason}。`
      + '在主 agent 处理之前成员的 submit_work 都返回 halted。configure_landing 的 branch:"restore" 把分支恢复到队列上次落地的位置（外来提交保存在返回的 kept 引用下），branch:"adopt" 按现状接纳；查明来源，成员只应通过 submit_work 落地。' });
    if (known.halt && known.halt.head === current) return stopped(known.halt.reason);
    const halt = (reason: string) => { this.putHead(ws, { targetRef, head: known.head, halt: { head: current, reason } }); return stopped(reason); };
    if (!current) return halt('the landing branch was deleted');
    if ((await this.git(ws.repository, ['merge-base', '--is-ancestor', known.head, current], signal, true)).code) return halt(`the branch no longer contains ${short(known.head)}, so landed work is missing from it`);
    const changed = (await this.git(ws.repository, ['diff', '--name-only', '--no-renames', '-z', known.head, current], signal)).stdout.split('\0').filter(Boolean);
    const barred = (landing.protect ?? []).flatMap(rule => rule.paths.map(pathPattern));
    const files = changed.filter(file => barred.some(pattern => pattern.test(file)));
    if (files.length) return halt(`the outside commits change protected paths (${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''})`);
    await this.park(path, current, signal);
    const commands = [...landing.precheck ?? [], ...landing.commands];
    const results = await this.run(path, commands, signal, deadlineAt);
    const failed = results.find(result => result.code);
    if (failed || results.length !== commands.length) {
      return halt(`the outside commits fail the landing checks (${failed ? `${failed.argv.join(' ').slice(0, 200)} exited ${failed.code}: ${(failed.stderr || failed.stdout).trim().slice(-600)}` : 'the checks did not finish'})`);
    }
    const count = (await this.git(ws.repository, ['rev-list', '--count', `${known.head}..${current}`], signal)).stdout.trim();
    this.putHead(ws, { targetRef, head: current });
    return { notice: `落地分支 ${targetRef} 有 ${count} 个提交未经 submit_work 进入（${short(known.head)}..${short(current)}）。它们接在队列上次落地的位置之后、没有改动受保护路径，并通过了落地检查，队列已接纳并继续落地。查明来源，成员只应通过 submit_work 落地。` };
  }

  /**
   * One train. Stacks the batch on the branch head in the train's worktree, in the order submitted, and runs the
   * checks on the whole stack. If they pass, the branch advances to the stack and everyone on it has landed. If they
   * fail, the stack is bisected for the first submission that breaks the checks: the ones before it land, it gets the
   * failed checks back, and the ones after it ride the next train. A submission that does not apply to the branch
   * head is a conflict; one that only fails to apply on top of this train's cargo is tried first on the next train.
   * Returns the submissions to queue again.
   */
  private async round(landing: WorkspaceLanding, batch: Candidate[]): Promise<Candidate[]> {
    const { signal } = this.stopping, { targetRef } = landing, { ws } = batch[0]!;
    const path = await this.trainWorktree(ws, signal);
    const deadlineAt = Math.max(...batch.map(candidate => candidate.ctx.state.deadlineAt));
    // The branch may have been moved since the members rebased onto it.
    const verdict = await this.inspect(landing, ws, deadlineAt);
    if (verdict.halt) { for (const candidate of batch) candidate.resolve(this.halted(targetRef, verdict)); return []; }
    const expected = verdict.head, key = this.trainKey(ws);
    const notice = this.unsaid.get(key);
    let said = false;
    const told = <T extends LandReport>(report: T): T => { if (!notice) return report; said = true; return { ...report, notice }; };
    const start = expected ?? batch[0]!.base;
    const at = (commit: string) => this.park(path, commit, signal);
    await at(start);
    const identity = await this.identity(path, signal);
    const stack: Candidate[] = [], heads = [start], again = new Set<Candidate>();
    for (const candidate of batch) {
      if (candidate.ctx.signal.aborted) { candidate.reject(candidate.ctx.signal.reason); continue; }
      const head = heads.at(-1)!;
      const detail = await this.stack(path, head, candidate, identity, signal);
      if (detail === undefined) { stack.push(candidate); heads.push(await this.revision(path, undefined, signal)); }
      else if (head === start) candidate.resolve(told({ status: 'conflict', targetRef, targetCommit: start, detail }));
      else { again.add(candidate); await at(head); }
    }
    const check = async (commit: string): Promise<CheckFailure | undefined> => {
      await at(commit);
      const commands = tail(await this.run(path, landing.commands, signal, deadlineAt));
      if (commands.length !== landing.commands.length || commands.some(result => result.code)) return { commands };
      if ((await this.git(path, ['status', '--porcelain', '--untracked-files=all'], signal)).stdout.trim()) return { commands, reason: 'Checks left uncommitted or untracked files in the worktree' };
      if (await this.revision(path, undefined, signal) !== commit) return { commands, reason: 'Checks changed the worktree HEAD' };
      return undefined;
    };
    // heads[n] is the stack after n submissions. The branch head, heads[0], passed when it landed.
    let good = 0, bad = stack.length + 1, failure: CheckFailure | undefined;
    for (let probe = stack.length; bad - good > 1; probe = Math.floor((good + bad) / 2)) {
      const failed = await check(heads[probe]!);
      if (failed) { bad = probe; failure = failed; } else good = probe;
    }
    const head = heads[good]!;
    if (good) {
      if (await this.refHead(ws.repository, targetRef, signal) !== expected) throw new Error('Landing branch was moved from outside the landing queue; submit again');
      await this.notCheckedOut(ws, targetRef, signal);
      const landed = stack.slice(0, good), from = landed.slice(0, 16).map(candidate => candidate.ws.id.slice(0, 8)).join(',');
      await this.advance(ws, targetRef, head, expected, `bridge-workflow: landed ${good} submission(s), ${landed.reduce((total, candidate) => total + candidate.commits, 0)} commit(s) from ${from}${good > 16 ? ',…' : ''}`, signal);
    }
    for (const candidate of stack.slice(0, good)) candidate.resolve(told({ status: 'landed', targetRef, headCommit: head, commits: candidate.commits }));
    if (failure) stack[bad - 1]!.resolve(told({ status: 'check_failed', targetRef, targetCommit: head, headCommit: heads[bad]!, ...failure }));
    for (const candidate of stack.slice(bad)) again.add(candidate);
    // Said once a report carried it; a train that only requeues its submissions says it on the next.
    if (said) this.unsaid.delete(key);
    return batch.filter(candidate => again.has(candidate));
  }
  /** Puts a submission's commits on top of `head` in the train's worktree; returns Git's complaint when they do not apply. */
  private async stack(path: string, head: string, candidate: Candidate, identity: string[], signal: AbortSignal): Promise<string | undefined> {
    // Nothing landed since the member rebased: its commits go on as they are.
    if (candidate.base === head) { await this.git(path, ['reset', '--hard', '--quiet', candidate.head], signal); return undefined; }
    let picked = await this.git(path, [...identity, 'cherry-pick', '--allow-empty', `${candidate.base}..${candidate.head}`], signal, true);
    for (let skipped = 0; picked.code; skipped++) {
      // A commit the branch already holds stops the pick with nothing to commit: skip it. Anything else is a conflict.
      const stopped = !(await this.git(path, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'], signal, true)).code;
      const dirty = (await this.git(path, ['status', '--porcelain', '--untracked-files=no'], signal)).stdout.trim();
      if (!stopped || dirty || skipped > candidate.commits) {
        await this.git(path, ['cherry-pick', '--abort'], signal, true);
        return (picked.stdout + picked.stderr).slice(-4000);
      }
      picked = await this.git(path, [...identity, 'cherry-pick', '--skip'], signal, true);
    }
    return undefined;
  }
  /** The train's own worktree, one for each workflow and repository; it keeps the checks' build outputs between trains. */
  private trainPath(ws: WorkspaceBinding): string {
    return join(resolve(this.directory), ws.workflowId, `train-${workflowDigest(ws.commonDir).slice(0, 16)}`);
  }
  private async trainWorktree(ws: WorkspaceBinding, signal: AbortSignal): Promise<string> {
    const path = this.trainPath(ws);
    if (await access(join(path, '.git')).then(() => true, () => false)) await this.git(path, ['cherry-pick', '--abort'], signal, true);
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await this.worktree(ws, ['add', '--detach', '--lock', '--reason', `bridge-workflow:train:${ws.workflowId}`, path, ws.baseCommit], signal);
    }
    return path;
  }
  /** Removes the train's worktree once the last member worktree of its repository is gone. */
  private async retireTrain(ws: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    const left = this.db.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE workflow=? AND kind='workspace' AND json_extract(data,'$.kind')='task' AND json_extract(data,'$.status')!='removed' AND json_extract(data,'$.commonDir')=?").get(ws.workflowId, ws.commonDir) as { n: number };
    const path = this.trainPath(ws);
    if (left.n || this.trains.has(`${ws.workflowId}:${ws.commonDir}`) || !await access(path).then(() => true, () => false)) return;
    await this.worktree(ws, ['unlock', path], signal, true);
    await this.worktree(ws, ['remove', '--force', path], signal, true);
  }

  /**
   * The main agent's view of the landing and its changes to it while the workflow runs; without options it only
   * reports. `checks`, `precheck` (empty for none) and `batch` replace the script's settings, `protect` adds rules to
   * the script's (empty for none added), and `reset` drops every earlier change first. New commands are first run on
   * the landing branch as it is: on a branch that fails them every submission would be blamed for it, so the change
   * is refused and the branch has to be repaired under the current checks first. `branch` settles a branch the queue
   * does not vouch for: "restore" puts it back where the queue left it and keeps the outside commits under a ref,
   * "adopt" has the queue vouch for it as it is.
   */
  configure(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<LandingChange> {
    if (this.closed) return Promise.reject(new Error('Workspace service is closed'));
    const pending = this.configureInner(ctx, input); this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  private async configureInner(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<LandingChange> {
    const workflow = ctx.state.workflowId, { signal } = this.stopping;
    if (Object.keys(input).some(key => !['checks', 'precheck', 'protect', 'batch', 'reset', 'branch'].includes(key))) throw new Error('Unsupported configure_landing option');
    if (input.reset !== undefined && input.reset !== true) throw new Error('reset is true or left out');
    if (input.branch !== undefined && input.branch !== 'restore' && input.branch !== 'adopt') throw new Error('branch is "restore" or "adopt"');
    const base = this.record<WorkspaceLanding>(workflow, '@landing');
    if (!base) throw new Error('Landing is not configured; the script calls configureLanding first');
    const empty = (value: unknown) => Array.isArray(value) && !value.length;
    const stored = this.record<LandingOverride>(workflow, LANDING_OVERRIDE) ?? {};
    const next: LandingOverride = { ...(input.reset ? {} : stored),
      ...(input.checks === undefined ? {} : { commands: this.commands(input.checks) }),
      ...(input.precheck === undefined ? {} : { precheck: empty(input.precheck) ? [] : this.commands(input.precheck) }),
      ...(input.protect === undefined ? {} : { protect: empty(input.protect) ? [] : this.protect(input.protect)! }),
      ...(input.batch === undefined ? {} : { batch: boundedInteger(input.batch, 16, 1, 64) }) };
    if (!next.protect?.length) delete next.protect;
    const repos = this.landingRepositories(workflow, ctx.state.root);
    const settled: NonNullable<LandingChange['settled']> = [];
    if (input.branch) for (const ws of repos) {
      const outcome = await this.exclusive(this.trainKey(ws), () => this.settle(ws, base.targetRef, input.branch as 'restore' | 'adopt', signal));
      if (outcome) settled.push(outcome);
    }
    const current = this.effective(base, stored), wanted = this.effective(base, next);
    const differs = (a: unknown, b: unknown) => workflowDigest(a ?? null) !== workflowDigest(b ?? null);
    const changed = differs(current, wanted) || differs(stored, next);
    // Only commands the branch has not been held to are tried on it.
    const fresh = [...(wanted.precheck && differs(wanted.precheck, current.precheck) ? wanted.precheck : []), ...(differs(wanted.commands, current.commands) ? wanted.commands : [])];
    // Every train of the workflow waits while the commands are tried, so none lands under the old ones meanwhile.
    const apply = (index: number): Promise<LandingRefusal | undefined> => {
      if (index === repos.length) { if (changed) this.put(workflow, LANDING_OVERRIDE, 'landing-override', next); return Promise.resolve(undefined); }
      if (!fresh.length) return apply(index + 1);
      return this.exclusive(this.trainKey(repos[index]!), async () => await this.tryOn(repos[index]!, base.targetRef, fresh, ctx.state.deadlineAt, signal) ?? apply(index + 1));
    };
    const refused = changed ? await apply(0) : undefined;
    return { changed: changed && !refused, ...(refused ? { refused } : {}), ...(settled.length ? { settled } : {}),
      landing: await this.view(base, refused ? stored : next, repos, signal) };
  }
  /** One ready member worktree for each repository the workflow lands in, in a fixed order. */
  private landingRepositories(workflow: string, root: WorkflowRoot): WorkspaceBinding[] {
    const rows = this.db.prepare("SELECT data FROM workspace_records WHERE workflow=? AND kind='workspace' AND json_extract(data,'$.kind')='task' AND json_extract(data,'$.status')='ready'").all(workflow) as Array<{ data: string }>;
    const repos = new Map<string, WorkspaceBinding>();
    for (const row of rows) {
      const ws = JSON.parse(row.data) as WorkspaceBinding;
      if (ws.rootDigest !== workflowDigest(root)) throw new Error('Workspace authorization changed');
      if (!repos.has(ws.commonDir)) repos.set(ws.commonDir, ws);
    }
    return [...repos.values()].sort((a, b) => a.commonDir < b.commonDir ? -1 : 1);
  }
  /** Runs commands on the landing branch as it is, in the train's worktree; tells why the branch does not pass them. */
  private async tryOn(ws: WorkspaceBinding, targetRef: string, commands: WorkspaceCommands, deadlineAt: number, signal: AbortSignal): Promise<LandingRefusal | undefined> {
    const head = await this.refHead(ws.repository, targetRef, signal);
    if (!head) return undefined;
    const path = await this.trainWorktree(ws, signal);
    await this.park(path, head, signal);
    const results = tail(await this.run(path, commands, signal, deadlineAt));
    const refusal = (reason: string) => ({ repository: ws.repository, headCommit: head, reason, commands: results });
    if (results.length !== commands.length || results.some(result => result.code)) return refusal('The landing branch fails these commands as it is, so every submission would be blamed for it. Nothing was changed: land the repair under the current checks first, then change them.');
    if ((await this.git(path, ['status', '--porcelain', '--untracked-files=all'], signal)).stdout.trim()) return refusal('The commands left uncommitted or untracked files in the worktree; every landing would fail for that. Nothing was changed.');
    return undefined;
  }
  private async settle(ws: WorkspaceBinding, targetRef: string, action: 'restore' | 'adopt', signal: AbortSignal): Promise<NonNullable<LandingChange['settled']>[number] | undefined> {
    const current = await this.refHead(ws.repository, targetRef, signal);
    const known = this.vouched(ws, targetRef, current);
    if (!known || known.head === current) return undefined;
    if (action === 'adopt') {
      if (!current) throw new Error('The landing branch was deleted; restore it');
      this.putHead(ws, { targetRef, head: current });
      return { repository: ws.repository, branch: 'adopted', head: current };
    }
    await this.notCheckedOut(ws, targetRef, signal);
    const kept = current ? `refs/bridge-workflow/${ws.workflowId}/outside/${current}` : undefined;
    if (kept) await this.git(ws.repository, ['update-ref', kept, current!], signal);
    await this.git(ws.repository, ['update-ref', '-m', 'bridge-workflow: restored after a move from outside the landing queue', targetRef, known.head, current ?? '0'.repeat(known.head.length)], signal);
    this.putHead(ws, { targetRef, head: known.head });
    return { repository: ws.repository, branch: 'restored', head: known.head, ...(kept ? { kept } : {}) };
  }
  private async view(base: WorkspaceLanding, over: LandingOverride, repos: WorkspaceBinding[], signal: AbortSignal): Promise<LandingView> {
    const landing = this.effective(base, over), branches: LandingView['branches'] = [];
    for (const ws of repos) {
      const head = await this.refHead(ws.repository, landing.targetRef, signal);
      const known = this.vouched(ws, landing.targetRef, head);
      branches.push({ repository: ws.repository, head, ...(known ? { landed: known.head } : {}), waiting: this.trains.get(this.trainKey(ws))?.queue.length ?? 0,
        ...(known?.halt && known.halt.head === head ? { halted: known.halt.reason } : {}) });
    }
    const names: Record<keyof LandingOverride, string> = { commands: 'checks', precheck: 'precheck', protect: 'protect', batch: 'batch' };
    return { targetRef: landing.targetRef, checks: landing.commands, ...(landing.precheck ? { precheck: landing.precheck } : {}), ...(landing.protect ? { protect: landing.protect } : {}),
      batch: landing.batch, overridden: (Object.keys(names) as Array<keyof LandingOverride>).filter(key => over[key] !== undefined).map(key => names[key]), branches };
  }

  private async check(ctx: WorkspaceContext, op: RecordRow, ws: WorkspaceBinding, value: unknown): Promise<WorkspaceChecks> {
    const commands = this.commands(value);
    const pinned = await this.clean(ws, ctx.signal);
    const results = await this.run(ws.path, commands, ctx.signal, ctx.state.deadlineAt);
    const after = await this.clean(ws, ctx.signal);
    const passed = results.length === commands.length && results.every(result => result.code === 0) && after.headCommit === pinned.headCommit && after.tree === pinned.tree;
    return this.internal<WorkspaceChecks>(op, 'checks', 'checks', id => ({ id, workspaceId: ws.id, ...pinned, passed, commands: results }));
  }

  async close(): Promise<void> {
    this.closed = true; this.stopping.abort(new Error('Workspace service is closed'));
    await Promise.allSettled([...this.pending]); this.db.close();
  }
}
