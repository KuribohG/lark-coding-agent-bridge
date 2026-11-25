import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { access, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { workflowDigest } from './digest';
import { MAX_WORKSPACES, MAX_WORKSPACE_RECORDS, TRAIN_HALT_POLL_MS, TRAIN_RETRY_DELAYS_MS, TRAIN_STALE_LOCK_MS, WORKSPACE_CHECKOUT_SLOTS } from './limits';
import { boundedInteger, scriptText } from './script-contract';
import { WorkspaceOverlays } from './workspace-overlay';
import { nodeProcesses, records, workspaceCommand, type CommandOutput, type CommandResult } from './workspace-process';
import type { WorkflowProcesses } from './ports';
import type { LandingChange, LandingHead, LandingOverride, LandingRefusal, LandingView, LandReport, LandSubmitted, WorkspaceApproval, WorkspaceBinding, WorkspaceChange, WorkspaceChecks, WorkspaceCommands, WorkspaceContext, WorkspaceIntegration, WorkspaceLanding } from './workspace-types';
import type { WorkflowRoot } from './types';

interface RecordRow { id: string; workflow: string; key: string; kind: string; digest: string; done: number; data: string; created: number }
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const BUSY = new Set(['queued', 'starting', 'running', 'cancelling', 'waiting_workflow']);
/** A check command runs foreground work that competes with every other worker on the host: five minutes unless it is asked for more, at most four hours, and never past the workflow deadline. */
const CHECK_TIMEOUT_DEFAULT_MS = 300_000;
const CHECK_TIMEOUT_MAX_MS = 4 * 3_600_000;
/**
 * Every Git command here runs against a local checkout, but creating a worktree writes a whole checkout's files and
 * screening or reading it walks the tree, both of which scale with the repository and its filesystem. One hour
 * bounds a hung Git without failing a large repository on a network filesystem.
 */
const GIT_TIMEOUT_MS = 3_600_000;
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
interface Candidate { ws: WorkspaceBinding; base: string; head: string; commits: number; ctx: WorkspaceContext; resolve(report: LandReport): void; reject(error: unknown): void;
  /** Takes what the main agent should hear about the branch while the submission waits (see `LandInput`). */
  noticed?: (notice: string) => void;
  /** The queue has answered it; a train that runs again leaves it out. */
  settled?: boolean }
/** A Git command that failed. In a train's worktree that is the train's trouble, not that of the submissions it carries. */
class GitFailure extends Error {}
/** The landing branch moved while a train's checks ran, so what they passed on is no longer what would land. */
class BranchMoved extends Error {}
/** The landing branch is somewhere the queue cannot accept; its submissions wait until the main agent has settled it. */
class LandingHalted extends Error { constructor(readonly notice: string) { super(notice); } }
/** A train that failed for a reason of its own and runs again with the same submissions. */
interface TrainTrouble { failures: number; since: number; reason: string; repeated: boolean; mended?: string }
/** The run a train is on: the submissions it took from the queue and how far it has come with them. */
interface TrainRun { batch: Candidate[]; since: number; step: 'stacking' | 'checking'; checks: number }
interface Train { queue: Candidate[]; running: boolean; trouble?: TrainTrouble; current?: TrainRun;
  /** The halt the train waits out, as the main agent was told of it. */
  halted?: string;
  /** Ends the wait the train is in, when something it waits for may have changed. */
  wake?: () => void }
/**
 * What a task is doing in its worktree to submit its commits: the rebase, the screening and the precheck, until the
 * commits have joined the queue. A repeated call joins it; `detach` ends it, so the task can submit again there.
 */
interface Flight { report: Promise<LandReport>; detach(): void }
/**
 * What submit_work asks of `land`. `submitted` is called as the commits join the queue, which is when the member is
 * answered; when it throws they do not join, and the worktree keeps them. `noticed` takes what the main agent should
 * hear about the branch while they wait there.
 */
interface LandInput { workspace: string; taskId: string; submitted?: (info: LandSubmitted) => void; noticed?: (notice: string) => void }

/** How long a train waits before it runs again or looks at a halted branch again, and when a lock nobody releases counts as abandoned. */
export interface TrainTiming { retryDelaysMs: readonly number[]; staleLockMs: number; haltPollMs: number }
/** What Git says when the index of a worktree cannot be read at all. */
const INDEX_UNREADABLE = /index file smaller than expected|index file corrupt|bad index file sha1 signature|bad signature 0x|bad index version/;
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
/** Whether the workspace is a repository of its own, with the source checkout as a remote: a clone, or an overlay, which is a clone whose files are not copied. */
const apart = (ws: Pick<WorkspaceBinding, 'isolation'>) => ws.isolation === 'clone' || ws.isolation === 'overlay';

/** The journal precedes Git/filesystem operations. Successful results are immutable on replay. */
export class WorkflowWorkspaces {
  private readonly db: Database.Database;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly activeKeys = new Set<string>();
  /** Submissions waiting to land, for each workflow and repository; one train at a time runs on each. */
  private readonly trains = new Map<string, Train>();
  /** Stops the trains when the service closes. */
  private readonly stopping = new AbortController();
  /** The last piece of work that uses each train's worktree; a train and a trial of new checks take turns there. */
  private readonly tracks = new Map<string, Promise<unknown>>();
  /** What the main agent has yet to hear about each train's branch; it travels with the next reports. */
  private readonly unsaid = new Map<string, string>();
  /** The landing in progress in each worktree and when it began; a repeated submission joins it. */
  private readonly inFlight = new Map<string, Flight>();
  /** Commits whose tree this service already screened for submodules and checkout filters, one check per commit. */
  private readonly supported = new Map<string, Promise<void>>();
  /** The look at a source checkout for uncommitted changes that is under way; see `uncommitted`. */
  private readonly looking = new Map<string, Promise<{ count: number; first: string[] }>>();
  private readonly overlays: WorkspaceOverlays;
  /** The mounted overlay workspaces this service has checked: Git runs in them with the overlay's own change list. */
  private readonly overlaid = new Set<string>();
  private closed = false;
  private readonly timing: TrainTiming;
  /** Whether this Git stacks commits without a worktree (`merge-tree --merge-base`, Git 2.40); found out on first use. */
  private grafts = true;

  constructor(path: string, private readonly directory: string, private readonly processes: WorkflowProcesses = nodeProcesses, timing: Partial<TrainTiming> = {}) {
    this.timing = { retryDelaysMs: TRAIN_RETRY_DELAYS_MS, staleLockMs: TRAIN_STALE_LOCK_MS, haltPollMs: TRAIN_HALT_POLL_MS, ...timing };
    this.overlays = new WorkspaceOverlays(join(resolve(directory), 'overlay'), processes,
      (cwd, args, signal, allowFailure) => this.git(cwd, args, signal, allowFailure), signal => checkoutSlots.acquire(signal));
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
  /** Whether an unfinished creation has yet to record a worktree: until then nothing of it exists outside its own record. */
  private unmade(op: RecordRow): boolean {
    return op.kind === 'op:create' && !op.done
      && !this.db.prepare('SELECT 1 FROM workspace_records WHERE workflow=? AND key=?').get(op.workflow, `@${op.id}/workspace`);
  }
  private forget(op: RecordRow): void { this.db.prepare('DELETE FROM workspace_records WHERE id=?').run(op.id); }
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

  private async git(cwd: string, args: string[], signal: AbortSignal, allowFailure = false, env?: NodeJS.ProcessEnv, output?: CommandOutput): Promise<CommandResult> {
    const hooks = join(this.directory, 'empty-hooks'); await mkdir(hooks, { recursive: true, mode: 0o700 });
    // Git's own options (`-c name=value`) come before the subcommand.
    const name = `git ${args.find((arg, at) => !arg.startsWith('-') && args[at - 1] !== '-c') ?? ''}`.trim();
    // No fsmonitor of the user's runs here. An overlay workspace keeps its own: without it Git stats every file through
    // the mount, and a command that writes the index with it off strips what the member's own Git relies on.
    const fsmonitor = this.overlaid.has(cwd) ? await this.overlays.hook() : 'false';
    const result = await workspaceCommand('git', ['-c', `core.hooksPath=${hooks}`, '-c', `core.fsmonitor=${fsmonitor}`,
      '-c', 'gc.auto=0', ...args], cwd, signal, GIT_TIMEOUT_MS, { ...gitEnv(), ...env }, this.processes, { name, ...output });
    if (result.code && !allowFailure) throw new GitFailure(`Git ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 1600)}`);
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
    // The listing grows with the repository, so its entries are screened as Git prints them and none are held.
    const attributes: string[] = [];
    await this.git(repo, ['ls-tree', '-r', '-z', head], signal, false, undefined, { scan: records(entry => {
      if (entry.startsWith('160000 ')) throw new Error('Workspace v1 does not support submodules');
      const path = entry.slice(entry.indexOf('\t') + 1);
      if (path === '.gitattributes' || path.endsWith('/.gitattributes')) attributes.push(path);
    }) });
    for (const path of attributes) {
      const text = (await this.git(repo, ['show', `${head}:${path}`], signal)).stdout;
      if (/\bfilter\s*=/.test(text)) throw new Error('Workspace v1 does not support checkout filters or Git LFS');
    }
  }
  /**
   * What `git status` reports in a checkout: how many entries, and the first few. A directory nobody ignored can hold
   * more untracked files than this service lists at once, so the entries are counted as Git prints them.
   */
  private async status(path: string, signal: AbortSignal, untracked: 'all' | 'no' = 'all'): Promise<{ count: number; first: string[] }> {
    const first: string[] = [];
    let count = 0;
    // Listing every untracked file reads every directory. In an overlay only whether there are any is cheap to tell,
    // from Git's untracked cache, which serves the default listing (an untracked directory as one entry).
    const mode = untracked === 'all' && this.overlaid.has(path) ? 'normal' : untracked;
    await this.git(path, ['status', '--porcelain', `--untracked-files=${mode}`], signal, false, undefined,
      { scan: records(line => { if (line.trim() && count++ < 5) first.push(line.trim().slice(0, 200)); }, '\n') });
    return { count, first };
  }
  /**
   * What stands in the way of taking a checkout as a baseline. The look reads every file's status, half a minute for a
   * large checkout on a network filesystem, and staffing a swarm asks once for each member at the same moment: those
   * that ask while a look is under way share its answer.
   */
  private uncommitted(repository: string): Promise<{ count: number; first: string[] }> {
    const running = this.looking.get(repository);
    if (running) return running;
    const look = this.status(repository, this.stopping.signal).finally(() => { if (this.looking.get(repository) === look) this.looking.delete(repository); });
    this.looking.set(repository, look);
    return look;
  }
  /**
   * The paths that differ between two commits and match a pattern: how many, and the first of them. A large change
   * names more paths than this service lists at once, so they are matched as Git prints them.
   */
  private async touched(cwd: string, from: string, to: string, patterns: RegExp[], signal: AbortSignal): Promise<{ count: number; files: string[] }> {
    const files: string[] = [];
    let count = 0;
    if (patterns.length) await this.git(cwd, ['diff', '--name-only', '--no-renames', '-z', from, to], signal, false, undefined,
      { scan: records(file => { if (patterns.some(pattern => pattern.test(file)) && count++ < 64) files.push(file); }) });
    return { count, files };
  }
  /** The checkout worktrees are made from: the workflow's cwd, or the root of another checkout the script names. */
  private async repository(root: WorkflowRoot, signal: AbortSignal, repo?: unknown): Promise<{ repository: string; commonDir: string }> {
    const start = repo === undefined ? root.cwdRealpath : scriptText(repo, 'repository path', 1024);
    if (!isAbsolute(start)) throw new Error('repo must be an absolute path');
    // Git's own refusal names neither the directory it looked in nor the option that says where to look instead.
    const top = await this.git(start, ['rev-parse', '--show-toplevel'], signal, true);
    if (top.code) throw new Error(repo === undefined
      ? `The directory of this workflow is not a Git checkout (${start}): name the checkout to work in with the repo option, an absolute path to its root`
      : `repo is not a Git checkout: ${start}`);
    const repository = await realpath(top.stdout.trim());
    if (repository !== await realpath(start)) throw new Error(repo === undefined ? 'Workspace operations require the authorized repository root as cwd, or a repo option' : 'repo must be the root of a Git checkout');
    const commonDir = await realpath(resolve(repository, (await this.git(repository, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()));
    return { repository, commonDir };
  }

  /** The checkout a worktree was made from and how it is kept apart from it, as the options that make another like it. */
  origin(workflowId: string, id: string): { repo: string; isolation?: 'clone' | 'overlay' } {
    const ws = this.value<WorkspaceBinding>(id, workflowId, 'workspace');
    return { repo: ws.repository, ...(ws.isolation ? { isolation: ws.isolation } : {}) };
  }

  async binding(root: WorkflowRoot, workflowId: string, id: string, signal: AbortSignal): Promise<WorkspaceBinding> {
    const ws = this.value<WorkspaceBinding>(id, workflowId, 'workspace');
    if (ws.rootDigest !== workflowDigest(root) || ws.status !== 'ready') throw new Error('Workspace binding is unavailable or authorization changed');
    // The process that serves an overlay may have died since it was last used; whoever is bound to it finds it mounted.
    if (ws.isolation === 'overlay') { await this.overlays.mount(ws, signal); this.overlaid.add(ws.path); }
    const top = await realpath((await this.git(ws.path, ['rev-parse', '--show-toplevel'], signal)).stdout.trim());
    const common = await realpath(resolve(ws.path, (await this.git(ws.path, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()));
    const own = ws.isolation === 'clone' ? join(top, '.git') : ws.isolation === 'overlay' ? await realpath(this.overlays.place(ws).git) : ws.commonDir;
    if (top !== await realpath(ws.path) || common !== own
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
  /** Names the hosted process that runs under a lease. It may outlive this service, and then it keeps the lease. */
  hosted(ws: WorkspaceBinding, token: string, hostKey: string): void {
    const current = this.value<WorkspaceBinding>(ws.id, ws.workflowId, 'workspace');
    if (current.busy?.token !== token) throw new Error('Workspace execution ownership changed');
    current.busy.hostKey = hostKey; this.putWorkspace(current);
  }
  /** The hosted process that holds the workspace, if one does. */
  holder(ws: WorkspaceBinding): string | undefined {
    return this.value<WorkspaceBinding>(ws.id, ws.workflowId, 'workspace').busy?.hostKey;
  }
  /** Takes over the lease of a process that kept running while no service was attached, for the task that continues it. */
  adopt(ws: WorkspaceBinding, hostKey: string, taskId: string): string {
    return this.db.transaction(() => {
      const current = this.value<WorkspaceBinding>(ws.id, ws.workflowId, 'workspace');
      if (current.status !== 'ready') throw new Error('Workspace is unavailable');
      if (current.busy?.hostKey !== hostKey) throw new Error('Workspace is not held by the process being continued');
      const token = randomUUID(); current.busy = { token, taskId, ownerPid: process.pid, hostKey }; this.putWorkspace(current); return token;
    })();
  }
  /** Frees what a hosted process held, once it is known to have ended with no service attached to see it. */
  vacate(workflowId: string, hostKey: string): void {
    const rows = this.db.prepare("SELECT * FROM workspace_records WHERE workflow=? AND kind='workspace' AND json_extract(data,'$.busy.hostKey')=?").all(workflowId, hostKey) as RecordRow[];
    for (const row of rows) {
      const ws = JSON.parse(row.data) as WorkspaceBinding;
      delete ws.busy; this.save(row, ws);
    }
  }
  private idle(ws: WorkspaceBinding, ctx: WorkspaceContext): void {
    if (ws.busy || ctx.state.tasks.some(task => task.workspaceId === ws.id && BUSY.has(task.status))) throw new Error('Wait for every workspace task to exit before inspecting or changing it');
  }
  async clean(ws: WorkspaceBinding, signal: AbortSignal): Promise<{ headCommit: string; tree: string }> {
    const headCommit = await this.revision(ws.path, undefined, signal);
    if ((await this.status(ws.path, signal)).count) throw new Error('Workspace has uncommitted or untracked changes; commit the intended changes before freezing or validating');
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
      if (!(await this.git(ws.path, ['rev-parse', '--verify', name], signal, true)).code) throw new Error('Workspace still has an unfinished Git operation');
    }
    return { headCommit, tree: (await this.git(ws.path, ['rev-parse', `${headCommit}^{tree}`], signal)).stdout.trim() };
  }
  async verifySnapshot(ws: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    if (ws.kind === 'review' && (await this.clean(ws, signal)).headCommit !== ws.baseCommit) throw new Error('Reviewer changed the frozen candidate');
  }

  private async materialize(ctx: WorkspaceContext, op: RecordRow, seed: { repository: string; commonDir: string; baseCommit: string; kind: WorkspaceBinding['kind']; isolation?: 'clone' | 'overlay'; changeId?: string }, checkout = seed.baseCommit): Promise<WorkspaceBinding> {
    // Removed worktrees are kept as records for replay and audit, but they no longer hold a directory or a slot.
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE workflow=? AND kind='workspace' AND COALESCE(json_extract(data,'$.status'),'')!='removed'").get(op.workflow) as { n: number }).n;
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
    if (apart(ws)) await this.clone(ws, checkout, ctx.signal);
    else {
      const exists = await access(join(ws.path, '.git')).then(() => true, () => false);
      // Only registration races with other Git commands; leave `worktree add` cheap and write the files separately.
      if (!exists) await this.worktree(ws, ['add', '--no-checkout', '--detach', '--lock', '--reason', `bridge-workflow:${ws.id}`, ws.path, checkout], ctx.signal);
    }
    // An overlay shows the baseline's files as soon as it is mounted; only another commit's differences are written.
    if (ws.isolation !== 'overlay' || checkout !== ws.baseCommit) await this.writeTree(ws.path, checkout, ctx.signal);
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
    await this.removeClone(ws, signal);
    await this.git(ws.repository, ['update-ref', this.cloneRef(ws), checkout], signal);
    // An overlay's repository is kept beside its mount: the mount shows the `.git` file that names it, the first thing
    // in the directory of the workspace's changes, and Git's own files are read and written without passing through it.
    const overlay = ws.isolation === 'overlay'
      ? { base: await this.overlays.base(ws, ws.baseCommit, signal), ...await this.overlays.prepare(ws, signal) } : undefined;
    const at = overlay?.upper ?? ws.path;
    await this.git(ws.repository, ['clone', '--quiet', '--shared', '--no-checkout', '--origin', CLONE_REMOTE,
      ...(overlay ? ['--separate-git-dir', overlay.git] : []), ws.repository, at], signal);
    await this.git(at, ['update-ref', '--no-deref', 'HEAD', checkout], signal);
    for (const key of ['user.name', 'user.email']) {
      const value = (await this.git(ws.repository, ['config', key], signal, true)).stdout.trim();
      if (value) await this.git(at, ['config', key, value], signal);
    }
    const remotes = (await this.git(ws.repository, ['config', '--local', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl|fetch)$'], signal, true)).stdout
      .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('\n')), entry.slice(entry.indexOf('\n') + 1)] as const)
      .filter(([key]) => key.slice('remote.'.length, key.lastIndexOf('.')) !== CLONE_REMOTE);
    for (const [key, value] of remotes) await this.git(at, ['config', '--add', key, value], signal);
    if (remotes.length) await this.git(at, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', CLONE_REMOTE,
      '+refs/remotes/*:refs/remotes/*', `^refs/remotes/${CLONE_REMOTE}/*`], signal);
    if (overlay) {
      await this.overlays.adopt(ws, overlay.base, signal);
      await this.overlays.mount(ws, signal); this.overlaid.add(ws.path);
    }
  }
  /** Deletes a clone's directory; the path is the one this service derives for the workspace, never one read back. */
  private async removeClone(ws: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    if (!apart(ws) || ws.path !== join(resolve(this.directory), ws.workflowId, ws.id)) throw new Error('Not a managed clone');
    // An overlay is unmounted first: deleting through the mount would record every file of the baseline as removed.
    if (ws.isolation === 'overlay') { this.overlaid.delete(ws.path); await this.overlays.remove(ws, signal); }
    await rm(ws.path, { recursive: true, force: true, maxRetries: 3 });
  }
  /**
   * A clone's commits are in its own object store. Before the source refers to one (a frozen change, a landing),
   * this copies it there and checks the source received the commit that was asked for.
   */
  private async publish(ws: WorkspaceBinding, head: string, signal: AbortSignal): Promise<void> {
    if (!apart(ws)) return;
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
    if (this.activeKeys.has(lock)) throw new Error('Workspace operation is already running; repeat the same call once it has finished');
    this.activeKeys.add(lock);
    try {
      ctx.signal.throwIfAborted();
      const digest = workflowDigest({ kind, args, root: ctx.state.root });
      let op = this.db.prepare('SELECT * FROM workspace_records WHERE workflow=? AND key=?').get(workflow, name) as RecordRow | undefined;
      // A creation that made nothing holds neither its key nor its inputs: one found unfinished is asked again with others.
      if (op && kind === 'create' && op.digest !== digest && this.unmade(op)) { this.forget(op); op = undefined; }
      if (op && (op.kind !== `op:${kind}` || op.digest !== digest)) throw new Error('Workspace key conflict: replay the original inputs');
      if (kind === 'approve' && !ctx.state.script?.calls.some(call => call.taskId === args.taskId)) throw new Error('Review task must belong to the current script run');
      if (op?.done) return JSON.parse(op.data);
      op ??= this.insert(workflow, name, `op:${kind}`, {}, digest, 0);
      let result: unknown;
      try { result = await this.apply(ctx, op, String(kind), args); } catch (error) {
        // Kept, the record of a creation that failed over its inputs refuses the key to any other input while the same
        // input fails again: a member that staff_swarm could not give a worktree could never be added under its name.
        if (kind === 'create' && this.unmade(op)) this.forget(op);
        throw error;
      }
      ctx.signal.throwIfAborted(); this.save(op, result, 1); return result;
    } finally { this.activeKeys.delete(lock); }
  }

  private async apply(ctx: WorkspaceContext, op: RecordRow, kind: string, args: Record<string, unknown>): Promise<unknown> {
    const id = (value: unknown) => scriptText(value, 'artifact ID', 100);
    if (kind === 'create') {
      if (args.change !== undefined && (args.base !== undefined || args.repo !== undefined || args.isolation !== undefined)) throw new Error('Choose base, repo and isolation, or change');
      if (args.isolation !== undefined && args.isolation !== 'worktree' && args.isolation !== 'clone' && args.isolation !== 'overlay') throw new Error('isolation is "worktree", "clone" or "overlay"');
      const isolation: { isolation?: 'clone' | 'overlay' } = args.isolation === 'clone' || args.isolation === 'overlay' ? { isolation: args.isolation } : {};
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
        const dirty = await this.uncommitted(repo.repository);
        // Whoever is refused is often not who left the files there: it is told which ones stand in the way and where.
        if (dirty.count) throw new Error(`Authorized checkout has uncommitted changes (${dirty.first.join(', ')}${dirty.count > 5 ? `, and ${dirty.count - 5} more` : ''}, in ${repo.repository}); choose a clean committed baseline first`);
        // A clone reads the source's objects from disk; ones a partial clone would fetch on demand are not there.
        if (isolation.isolation && (await this.git(repo.repository, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], ctx.signal, true)).stdout.trim()) throw new Error('Clone workspaces do not support partial-clone repositories');
        // Refused before anything is recorded when the host cannot mount one, so the key stays free for another isolation.
        if (isolation.isolation === 'overlay') await this.overlays.probe(ctx.signal);
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
        await this.git(ws.path, ['diff', '--check', ws.baseCommit, pinned.headCommit], ctx.signal, false, undefined, { keep: 'head' });
        // The diff is as large as the change; only its digest is recorded, so it is hashed as Git prints it.
        const diff = createHash('sha256');
        await this.git(ws.path, ['diff', '--binary', ws.baseCommit, pinned.headCommit], ctx.signal, false, undefined, { scan: chunk => { diff.update(chunk); } });
        const files = (await this.git(ws.path, ['diff', '--name-only', '-z', ws.baseCommit, pinned.headCommit], ctx.signal)).stdout.split('\0').filter(Boolean);
        const change = this.internal<WorkspaceChange>(op, 'change', 'change', id => ({ id, workspaceId: ws.id, baseCommit: ws.baseCommit, ...pinned, diffDigest: diff.digest('hex'), files }));
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
    if (intent.removing && (apart(ws) || !await access(ws.path).then(() => true, () => false))) {
      if (ws.busy && ws.busy.token !== intent.token) throw new Error('Workspace execution ownership changed');
      if (apart(ws)) await this.dropClone(ws, ctx.signal);
      else {
        const listed = (await this.worktree(ws, ['list', '--porcelain'], ctx.signal)).stdout;
        if (listed.split('\n').includes(`worktree ${ws.path}`)) throw new Error('Missing worktree is still registered; preserve for recovery');
      }
      this.putWorkspace({ ...ws, status: 'removed', busy: undefined });
      this.retireBase(ws);
      return { workspace: ws.id, removed: true };
    }
    this.idle(ws, ctx);
    ws = await this.binding(ctx.state.root, op.workflow, ws.id, ctx.signal);
    const token = this.begin(ws);
    try {
      // Cleanup discards the directory, uncommitted and unintegrated changes included: a member that cannot be
      // revived is better redone than kept around for work nobody may ever land.
      this.save(op, { removing: true, token });
      if (apart(ws)) await this.dropClone(ws, ctx.signal);
      else {
        const unlock = await this.worktree(ws, ['unlock', ws.path], ctx.signal, true);
        if (unlock.code && !unlock.stderr.includes('not locked')) throw new Error('Cannot unlock worktree');
        await this.worktree(ws, ['remove', '--force', ws.path], ctx.signal);
      }
      this.putWorkspace({ ...ws, status: 'removed', busy: { token, ownerPid: process.pid } });
      this.retireBase(ws);
      if (ws.kind === 'task') await this.retireTrain(ws, ctx.signal);
      return { workspace: ws.id, removed: true };
    } finally { this.end(ws, token); }
  }

  /** Removes a clone and the source's ref on it. What the clone landed or froze is held by other refs. */
  private async dropClone(ws: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    await this.removeClone(ws, signal);
    await this.git(ws.repository, ['update-ref', '-d', this.cloneRef(ws)], signal, true);
  }
  /** Deletes the baseline checkout an overlay read, once no workspace of any workflow is left that reads it. */
  private retireBase(ws: WorkspaceBinding): void {
    if (ws.isolation !== 'overlay') return;
    const left = this.db.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE kind='workspace' AND json_extract(data,'$.isolation')='overlay' AND COALESCE(json_extract(data,'$.status'),'')!='removed' AND json_extract(data,'$.commonDir')=? AND json_extract(data,'$.baseCommit')=?").get(ws.commonDir, ws.baseCommit) as { n: number };
    if (!left.n) void this.overlays.retire(ws, ws.baseCommit).catch(() => undefined);
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
      const merged = await this.git(repo.repository, ['merge-tree', '--write-tree', head, change.headCommit], ctx.signal, true, undefined, { keep: 'head' });
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
      return { argv: item.argv.map(arg => scriptText(arg, 'command argument', 4000)), timeoutMs: boundedInteger(item.timeoutMs, CHECK_TIMEOUT_DEFAULT_MS, 100, CHECK_TIMEOUT_MAX_MS) };
    });
  }
  /** Runs the commands in order in the directory and stops at the first failure. */
  private async run(path: string, commands: WorkspaceCommands, signal: AbortSignal, deadlineAt: number): Promise<WorkspaceChecks['commands']> {
    const results: WorkspaceChecks['commands'] = [];
    for (const command of commands) {
      // Only the end of a check's output is reported, so only that is held: a build may print as much as it likes.
      const result = await workspaceCommand(command.argv[0]!, command.argv.slice(1), path, signal,
        Math.max(1, Math.min(command.timeoutMs, deadlineAt - Date.now())), gitEnv(), this.processes, { keep: 'tail' });
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
  /**
   * Submits the commits of a member's worktree to the landing queue. Called by the task running in that worktree. The
   * worktree is rebased onto the branch, screened for protected paths and prechecked on its own, side by side with
   * other members, and what fails there is the answer. Then the commits join the queue by their IDs, `submitted` is
   * called, and the worktree goes back to the tip of the branch for the member's next item: the queue does not look
   * at it again. The promise settles with what the queue made of the commits (see `round`), which may be much later.
   */
  land(ctx: WorkspaceContext, input: LandInput): Promise<LandReport> {
    if (this.closed) return Promise.reject(new Error('Workspace service is closed'));
    const key = `${ctx.state.workflowId}:${input.workspace}:${input.taskId}`;
    const joined = this.inFlight.get(key);
    if (joined) return joined.report;
    const flight = { detach: () => { if (this.inFlight.get(key) === flight) this.inFlight.delete(key); } } as Flight;
    // The rebase and the precheck stop with the service as well as with whoever submitted.
    const pending = flight.report = this.landInner({ ...ctx, signal: AbortSignal.any([ctx.signal, this.stopping.signal]) }, input, flight);
    this.pending.add(pending); this.inFlight.set(key, flight);
    void pending.finally(() => { this.pending.delete(pending); flight.detach(); }).catch(() => {});
    return pending;
  }
  private async landInner(ctx: WorkspaceContext, input: LandInput, flight: Flight): Promise<LandReport> {
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
      const rebased = await this.git(ws.path, [...await this.identity(ws.path, signal), 'rebase', targetCommit], signal, true, undefined, { keep: 'tail' }).catch(async error => { await undo(); throw error; });
      if (rebased.code) await undo();
      if (rebased.code) return { status: 'conflict', targetRef, targetCommit, detail: (rebased.stdout + rebased.stderr).slice(-4000) };
    }
    const pinned = await this.clean(ws, signal);
    if (pinned.headCommit === targetCommit) return nothing;
    if (landing.protect) {
      const barred = landing.protect.filter(rule => !rule.allow.includes(ws.id)).flatMap(rule => rule.paths.map(pathPattern));
      const { count, files } = await this.touched(ws.path, targetCommit, pinned.headCommit, barred, signal);
      if (count) return { status: 'rejected', targetRef, targetCommit, files,
        reason: `${count} changed path(s) are protected from this worktree; resubmit commits that leave them as they are on the landing branch` };
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
    signal.throwIfAborted();
    // The queue takes the commits by their IDs. The worktree starts the member's next item where a landing would
    // leave it: at the tip of the branch, without commits that may yet be turned back. One that cannot be moved is
    // left to the member, which is told so.
    const quiet = new AbortController().signal;
    const moved = await this.git(ws.path, ['reset', '--hard', '--quiet', targetCommit], quiet, true).then(result => !result.code, () => false);
    flight.detach();
    try { input.submitted?.({ targetRef, targetCommit, headCommit: pinned.headCommit, commits, worktree: moved ? 'reset' : 'kept' }); }
    catch (error) {
      // Nobody answers for the commits (the claim they were submitted for ended meanwhile, say). The queue does not
      // take them, and the worktree gets them back for whoever works there next.
      const back = !moved || await this.git(ws.path, ['reset', '--hard', '--quiet', pinned.headCommit], quiet, true).then(result => !result.code, () => false);
      if (back) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)}. The commits are ${targetCommit}..${pinned.headCommit}, and the worktree was moved back to ${targetCommit}: git cherry-pick brings them back`);
    }
    const boarded = this.board({ ws, base: targetCommit, head: pinned.headCommit, commits, ctx, ...(input.noticed ? { noticed: input.noticed } : {}) });
    // Whoever submitted may be gone when the queue answers.
    void boarded.catch(() => {});
    return boarded;
  }
  private async identity(path: string, signal: AbortSignal): Promise<string[]> {
    return (await this.git(path, ['config', 'user.email'], signal, true)).stdout.trim() ? [] : ['-c', 'user.name=Bridge workflow', '-c', 'user.email=workflow@localhost'];
  }

  /** Queues a submission for the next train of its workflow and repository; settles when a train has dealt with it. */
  private board(change: Omit<Candidate, 'resolve' | 'reject'>): Promise<LandReport> {
    const key = `${change.ws.workflowId}:${change.ws.commonDir}`, { signal } = change.ctx;
    const train: Train = this.trains.get(key) ?? { queue: [], running: false }, { queue } = train;
    this.trains.set(key, train);
    return new Promise<LandReport>((resolve, reject) => {
      // A member whose turn ended leaves the queue; once on a train its work lands or fails with the rest.
      const leave = () => { const at = queue.indexOf(candidate); if (at >= 0) { queue.splice(at, 1); reject(signal.reason); } };
      const settled = <T>(settle: (value: T) => void) => (value: T) => { candidate.settled = true; signal.removeEventListener('abort', leave); settle(value); };
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
  private async drive(key: string, train: Train): Promise<void> {
    while (train.queue.length && !this.closed) {
      let wait: number | undefined;
      // The landing is read once the worktree is free: a change the main agent made meanwhile applies to this train.
      await this.exclusive(key, async () => {
        if (!train.queue.length) return;
        const landing = this.landing(train.queue[0]!.ws.workflowId);
        const batch = train.queue.splice(0, landing?.batch ?? train.queue.length);
        train.current = { batch, since: Date.now(), step: 'stacking', checks: 0 };
        try {
          if (!landing) throw new Error('Landing is not configured; the script calls configureLanding first');
          if (train.trouble) await this.mend(batch[0]!.ws, train.trouble).catch(() => undefined);
          const again = await this.round(landing, batch, train.trouble, train.current);
          train.current = undefined;
          train.queue.unshift(...again);
          train.trouble = undefined; train.halted = undefined;
        } catch (error) {
          train.current = undefined;
          // A train that failed for a reason of its own runs again: its submissions did nothing wrong, and handing
          // them back would send every member through its rebase, its precheck and the queue once more.
          const left = batch.filter(candidate => !candidate.settled);
          if (error instanceof LandingHalted && !this.closed) {
            // Nothing is wrong with the submissions: they keep their place and board again once the branch is settled.
            // The main agent hears of the halt once, through whichever of them can still pass it on.
            train.queue.unshift(...left);
            if (train.halted !== error.notice) { train.halted = error.notice; left.find(candidate => candidate.noticed)?.noticed!(error.notice); }
            wait = this.timing.haltPollMs;
            return;
          }
          wait = this.closed ? undefined : this.retryDelay(train, error);
          if (wait !== undefined) { train.queue.unshift(...left); return; }
          let failure = error;
          if (train.trouble && error instanceof GitFailure) {
            this.say(key, this.troubled(batch[0]!.ws, train.trouble, false));
            failure = new Error(`The landing train failed ${train.trouble.failures + 1} times in a row for a reason of its own and gave this batch up: ${error.message.trim()}\n`
              + 'Nothing is wrong with your commits and they are untouched. Do not run Git in the train\'s worktree and do not remove its lock files; submit again later.');
          }
          train.trouble = undefined;
          for (const candidate of left) candidate.reject(failure);
        }
      });
      // The worktree is free while the train waits, so the main agent can settle the branch or change the checks.
      if (wait) { await this.pause(wait, wake => { train.wake = wake; }); train.wake = undefined; }
    }
    for (const candidate of train.queue.splice(0)) candidate.reject(this.stopping.signal.reason);
    train.running = false;
    if (this.trains.get(key) === train) this.trains.delete(key);
  }
  /**
   * How long the train waits before it runs again with the same submissions, or nothing when they get the failure.
   * Only a failure of the train itself is waited out: a Git command that failed in its worktree, which is a lock
   * another process holds there or a file system that hiccuped, and a branch that moved while the checks ran, which
   * the next run looks at before anything else. A check that fails or runs out of time is the submissions' answer.
   */
  private retryDelay(train: Train, error: unknown): number | undefined {
    const delays = this.timing.retryDelaysMs, failures = (train.trouble?.failures ?? 0) + 1;
    if (!(error instanceof GitFailure || error instanceof BranchMoved) || failures > delays.length) return undefined;
    const reason = error.message.slice(0, 600);
    train.trouble = { failures, since: train.trouble?.since ?? Date.now(), reason, repeated: train.trouble?.reason === reason,
      ...(train.trouble?.mended ? { mended: train.trouble.mended } : {}) };
    return error instanceof BranchMoved ? 0 : delays[failures - 1]!;
  }
  /** What the main agent hears about a train that failed for a reason of its own; it travels with the next reports. */
  private troubled(ws: WorkspaceBinding, trouble: TrainTrouble, recovered: boolean): string {
    const minutes = Math.max(1, Math.round((Date.now() - trouble.since) / 60_000));
    return `落地列车（${ws.repository}）自身出错，${recovered ? `重跑 ${trouble.failures} 次后恢复（约 ${minutes} 分钟），这期间的提交留在队列里没有退回` : `连续 ${trouble.failures + 1} 次失败（约 ${minutes} 分钟）后把这一批提交退回给了成员`}：${trouble.reason.split('\n')[0]!.slice(0, 300)}。`
      + (/\.lock'/.test(trouble.reason) ? `这是列车工作树 ${this.trainPath(ws)} 的 Git 锁被别的进程占着：有人在里面运行了 git（git status 也会锁住索引）。成员不应在列车工作树里运行任何命令。` : '')
      + (trouble.mended ? `引擎已清除遗留的 ${trouble.mended}。` : '');
  }
  /** Adds to what the main agent has yet to hear about a train's branch. */
  private say(key: string, notice: string): void {
    const prior = this.unsaid.get(key);
    this.unsaid.set(key, prior && prior !== notice ? `${prior}\n${notice}` : notice);
  }
  private pause(ms: number, waker?: (wake: () => void) => void): Promise<void> {
    const { signal } = this.stopping;
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      waker?.(done);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  }
  /**
   * Clears what a process that is gone left in the train's own Git directory, before the train runs again. Whatever
   * the engine runs in that worktree takes turns, so a lock found there belongs to someone else: a member that ran
   * Git in it (`git status` locks the index while it scans the tree). One that still runs releases the lock and the
   * train only has to wait; one that was stopped leaves the lock for good, and a lock that old is removed. An index
   * that cannot be read twice in a row is dropped, and the reset every train starts with writes it anew.
   */
  private async mend(ws: WorkspaceBinding, trouble: TrainTrouble): Promise<void> {
    const lock = /Unable to create '(.+?\.lock)'/.exec(trouble.reason)?.[1];
    const unreadable = trouble.repeated && INDEX_UNREADABLE.test(trouble.reason);
    if (!lock && !unreadable) return;
    const { signal } = this.stopping;
    const named = (await this.git(this.trainPath(ws), ['rev-parse', '--absolute-git-dir'], signal, true)).stdout.trim();
    const own = named ? await realpath(named).catch(() => undefined) : undefined;
    // Only the worktree's own directory: a lock in the repository's shared one may be held for a member's worktree.
    if (!own || basename(dirname(own)) !== 'worktrees') return;
    if (lock && await realpath(dirname(lock)).catch(() => undefined) === own) {
      const file = join(own, basename(lock)), age = await stat(file).then(found => Date.now() - found.mtimeMs, () => undefined);
      if (age !== undefined && age >= this.timing.staleLockMs) { await rm(file, { force: true }); trouble.mended = `${basename(lock)}（${Math.round(age / 60_000)} 分钟未变）`; }
    }
    if (unreadable) { await rm(join(own, 'index'), { force: true }); trouble.mended = 'index（无法读取，已重建）'; }
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
    if (!verdict.halt) this.say(this.trainKey(ws), verdict.notice);
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
      + '已在队列里的提交留在队列里等待，新的 submit_work 返回 halted，直到主 agent 处理。configure_landing 的 branch:"restore" 把分支恢复到队列上次落地的位置（外来提交保存在返回的 kept 引用下），branch:"adopt" 按现状接纳；查明来源，成员只应通过 submit_work 落地。' });
    if (known.halt && known.halt.head === current) return stopped(known.halt.reason);
    const halt = (reason: string) => { this.putHead(ws, { targetRef, head: known.head, halt: { head: current, reason } }); return stopped(reason); };
    if (!current) return halt('the landing branch was deleted');
    if ((await this.git(ws.repository, ['merge-base', '--is-ancestor', known.head, current], signal, true)).code) return halt(`the branch no longer contains ${short(known.head)}, so landed work is missing from it`);
    const barred = (landing.protect ?? []).flatMap(rule => rule.paths.map(pathPattern));
    const hit = await this.touched(ws.repository, known.head, current, barred, signal);
    if (hit.count) return halt(`the outside commits change protected paths (${hit.files.slice(0, 8).join(', ')}${hit.count > 8 ? ', …' : ''})`);
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
   * One train. Stacks the batch on the branch head, in the order submitted, and runs the checks on the whole stack in
   * the train's worktree. If they pass, the branch advances to the stack and everyone on it has landed. If they
   * fail, the stack is bisected for the first submission that breaks the checks: the ones before it land, it gets the
   * failed checks back, and the ones after it ride the next train. A submission that does not apply to the branch
   * head is a conflict; one that only fails to apply on top of this train's cargo is tried first on the next train.
   * Returns the submissions to queue again.
   */
  private async round(landing: WorkspaceLanding, batch: Candidate[], trouble?: TrainTrouble, run?: TrainRun): Promise<Candidate[]> {
    const { signal } = this.stopping, { targetRef } = landing, { ws } = batch[0]!;
    const path = await this.trainWorktree(ws, signal);
    const deadlineAt = Math.max(...batch.map(candidate => candidate.ctx.state.deadlineAt));
    // The branch may have been moved since the members rebased onto it.
    const verdict = await this.inspect(landing, ws, deadlineAt);
    if (verdict.halt) throw new LandingHalted(verdict.notice ?? verdict.halt);
    const expected = verdict.head, key = this.trainKey(ws);
    // A train that got here after failing for a reason of its own says so; the main agent can tell the members.
    const notice = [this.unsaid.get(key), trouble && !(trouble.reason.startsWith('Landing branch was moved')) ? this.troubled(ws, trouble, true) : undefined].filter(Boolean).join('\n') || undefined;
    let said = false;
    const told = <T extends LandReport>(report: T): T => { if (!notice) return report; said = true; return { ...report, notice }; };
    const start = expected ?? batch[0]!.base;
    const at = (commit: string) => this.park(path, commit, signal);
    const identity = await this.identity(path, signal);
    const stack: Candidate[] = [], heads = [start], again = new Set<Candidate>();
    for (const candidate of batch) {
      if (candidate.ctx.signal.aborted) { candidate.reject(candidate.ctx.signal.reason); continue; }
      const head = heads.at(-1)!;
      let stacked = await this.graft(path, head, candidate, identity, signal);
      if (!stacked) {
        // Not a plain line of commits: the worktree picks them one by one.
        await at(head);
        const detail = await this.stack(path, head, candidate, identity, signal);
        stacked = detail === undefined ? { head: await this.revision(path, undefined, signal) } : { conflict: detail };
      }
      if ('head' in stacked) { stack.push(candidate); heads.push(stacked.head); }
      else if (head === start) candidate.resolve(told({ status: 'conflict', targetRef, targetCommit: start, detail: stacked.conflict }));
      else again.add(candidate);
    }
    const check = async (commit: string): Promise<CheckFailure | undefined> => {
      if (run) { run.step = 'checking'; run.checks++; }
      await at(commit);
      const commands = tail(await this.run(path, landing.commands, signal, deadlineAt));
      if (commands.length !== landing.commands.length || commands.some(result => result.code)) return { commands };
      if ((await this.status(path, signal)).count) return { commands, reason: 'Checks left uncommitted or untracked files in the worktree' };
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
      // The next run looks at the branch first: it vouches for what was added and stacks these submissions on it, or halts.
      if (await this.refHead(ws.repository, targetRef, signal) !== expected) throw new BranchMoved('Landing branch was moved from outside the landing queue; submit again');
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
  /**
   * Puts a submission's commits on top of `head` without a worktree. Each commit is merged into the stack in the object
   * database, the way a pick merges it (its parent is the merge base), and committed again with its author and message.
   * A pick in the worktree rewrites the index and looks at every file of the checkout for each commit, which on a
   * network file system takes longer than the merge by orders of magnitude, and it holds the index lock all the while.
   * Returns the new head, or what Git said of the conflict. Returns nothing for commits this does not stack (a merge, a
   * message in another encoding, a Git without `merge-tree --merge-base`): the worktree picks those.
   */
  private async graft(path: string, head: string, candidate: Candidate, identity: string[], signal: AbortSignal): Promise<{ head: string } | { conflict: string } | undefined> {
    // Nothing landed since the member rebased: its commits go on as they are.
    if (candidate.base === head) return { head: candidate.head };
    if (!this.grafts) return undefined;
    const field = '\x1f';
    const listed = await this.git(path, ['log', '-z', '--reverse', '--date=raw', `--format=${['%H', '%P', '%T', '%an', '%ae', '%ad', '%e', '%B'].join('%x1f')}`,
      `${candidate.base}..${candidate.head}`], signal).catch(error => { if (signal.aborted) throw error; return undefined; });
    if (!listed) return undefined;
    const commits = listed.stdout.split('\0').filter(Boolean).map(entry => {
      const [hash = '', parent = '', tree = '', name = '', email = '', date = '', encoding = '', ...message] = entry.split(field);
      return { hash, parent, tree, name, email, date, encoding, message: message.join(field) };
    });
    // A line of ordinary commits from the base to the head, each of which names all a new commit takes from it.
    const plain = commits.length > 0 && commits.every((commit, index) => SHA.test(commit.hash) && SHA.test(commit.tree)
      && commit.parent === (index ? commits[index - 1]!.hash : candidate.base) && commit.name && commit.email && /^\d+ [+-]\d{4}$/.test(commit.date)
      && !commit.encoding && commit.message.length <= 20_000 && !commit.message.includes('\0'));
    if (!plain || commits.at(-1)!.hash !== candidate.head) return undefined;
    const trees = (await this.git(path, ['rev-parse', `${candidate.base}^{tree}`, `${head}^{tree}`], signal)).stdout.trim().split('\n');
    let tip = head, tipTree = trees[1]!, parentTree = trees[0]!;
    for (const commit of commits) {
      const merged = await this.git(path, ['merge-tree', '--write-tree', '--name-only', `--merge-base=${commit.parent}`, tip, commit.hash], signal, true, undefined, { keep: 'tail' });
      // The tree comes first; what follows it names the files in conflict and says why.
      if (merged.code === 1) return { conflict: (merged.stdout.slice(merged.stdout.indexOf('\n') + 1).trim() || merged.stderr).slice(-4000) };
      const tree = merged.stdout.trim();
      if (merged.code || !SHA.test(tree)) {
        if (merged.code === 129 || /unknown option|usage: git merge-tree/.test(merged.stderr)) { this.grafts = false; return undefined; }
        throw new GitFailure(`Git merge-tree failed: ${(merged.stderr || merged.stdout).slice(0, 1600)}`);
      }
      // A commit the branch already holds changes nothing on it, and a pick skips it. One that was made empty is kept.
      if (tree !== tipTree || commit.tree === parentTree) {
        tip = (await this.git(path, [...identity, 'commit-tree', tree, '-p', tip, '-m', commit.message], signal, false,
          { GIT_AUTHOR_NAME: commit.name, GIT_AUTHOR_EMAIL: commit.email, GIT_AUTHOR_DATE: commit.date })).stdout.trim();
        if (!SHA.test(tip)) throw new GitFailure('Git commit-tree failed: it named no commit');
        tipTree = tree;
      }
      parentTree = commit.tree;
    }
    return { head: tip };
  }
  /** Puts a submission's commits on top of `head` in the train's worktree; returns Git's complaint when they do not apply. */
  private async stack(path: string, head: string, candidate: Candidate, identity: string[], signal: AbortSignal): Promise<string | undefined> {
    // Nothing landed since the member rebased: its commits go on as they are.
    if (candidate.base === head) { await this.git(path, ['reset', '--hard', '--quiet', candidate.head], signal); return undefined; }
    // A pick prints a line for every file its commits add; only the end of that is read, and only when it stops.
    let picked = await this.git(path, [...identity, 'cherry-pick', '--allow-empty', `${candidate.base}..${candidate.head}`], signal, true, undefined, { keep: 'tail' });
    for (let skipped = 0; picked.code; skipped++) {
      // A commit the branch already holds stops the pick with nothing to commit: skip it. Anything else is a conflict.
      const stopped = !(await this.git(path, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'], signal, true)).code;
      const dirty = (await this.status(path, signal, 'no')).count;
      if (!stopped || dirty || skipped > candidate.commits) {
        await this.git(path, ['cherry-pick', '--abort'], signal, true);
        return (picked.stdout + picked.stderr).slice(-4000);
      }
      picked = await this.git(path, [...identity, 'cherry-pick', '--skip'], signal, true, undefined, { keep: 'tail' });
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
    // A train that waits for the branch to be settled looks at it again now.
    if (settled.length) for (const ws of repos) this.trains.get(this.trainKey(ws))?.wake?.();
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
    if ((await this.status(path, signal)).count) return refusal('The commands left uncommitted or untracked files in the worktree; every landing would fail for that. Nothing was changed.');
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
      const train = this.trains.get(this.trainKey(ws));
      branches.push({ repository: ws.repository, head, ...(known ? { landed: known.head } : {}), waiting: train?.queue.length ?? 0,
        ...(known?.halt && known.halt.head === head ? { halted: known.halt.reason } : {}),
        ...(train?.current ? { train: { submissions: train.current.batch.length, step: train.current.step, checks: train.current.checks, since: train.current.since } } : {}),
        ...(train?.trouble ? { retrying: { failures: train.trouble.failures, since: train.trouble.since, reason: train.trouble.reason } } : {}) });
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
