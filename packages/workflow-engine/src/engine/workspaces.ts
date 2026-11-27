import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { access, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { workflowDigest } from './digest';
import { MAX_WORKSPACES, MAX_WORKSPACE_RECORDS, TRAIN_HALT_POLL_MS, TRAIN_LEDGER_KEPT, TRAIN_RETRY_DELAYS_MS, TRAIN_SLOW_CHECK_EXTRA_MS, TRAIN_SLOW_CHECK_FACTOR, TRAIN_STALE_LOCK_MS, TRAIN_USUAL_CHECKS, TRAIN_USUAL_CHECKS_MIN, WORKSPACE_CHECKOUT_PROCESSES, WORKSPACE_CHECKOUT_SLOTS, WORKSPACE_LARGE_CHECKOUTS } from './limits';
import { boundedInteger, scriptText } from './script-contract';
import { largeCheckout, writeCheckout, type CheckoutGit } from './workspace-checkout';
import { nodeProcesses, records, workspaceCommand, type CommandOutput, type CommandResult } from './workspace-process';
import { WsfsMounts, type WsfsOwner } from './workspace-wsfs';
import type { WorkflowProcesses } from './ports';
import type { LandingChange, LandingHead, LandingLive, LandingOverride, LandingRefusal, LandingRider, LandingTrain, LandingView, LandLabel, LandPosition, LandReport, LandSubmitted, LandWithdrawal, WorkspaceApproval, WorkspaceBinding, WorkspaceChange, WorkspaceChecks, WorkspaceCommands, WorkspaceContext, WorkspaceIntegration, WorkspaceLanding } from './workspace-types';
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
// Git registers a new worktree in several steps. Concurrent commands can observe a partial entry, so those of one
// repository run one at a time.
const worktreeCommands = new Map<string, Slots>();
/** The checkout a clone was made from, as the clone's remote. */
export const CLONE_REMOTE = 'bridge-source';
/** Where a clone offers the commit the source is about to fetch. */
const CLONE_PUBLISH_REF = 'refs/bridge-workflow/publish';
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });

/**
 * A counting semaphore: callers beyond the bound wait for a free slot instead of all running at once. A slot that
 * frees goes to the caller whose `rank` is lowest at that moment, and among equals to the one that has waited
 * longest; a caller without a rank comes after every one that has a number to show.
 */
class Slots {
  private free: number;
  private readonly waiting: Array<{ grant: () => void; cancel: () => void; rank?: () => number }> = [];
  constructor(private readonly size: number) { this.free = size; }
  /** Nobody holds a slot or waits for one. */
  get idle(): boolean { return this.free === this.size && !this.waiting.length; }
  async acquire(signal: AbortSignal, rank?: () => number): Promise<() => void> {
    signal.throwIfAborted();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      let first = 0, best = this.waiting[0]?.rank?.() ?? Infinity;
      for (let at = 1; at < this.waiting.length; at++) {
        const found = this.waiting[at]!.rank?.() ?? Infinity;
        if (found < best) { best = found; first = at; }
      }
      const [next] = this.waiting.splice(first, 1);
      if (next) next.grant(); else this.free++;
    };
    if (this.free > 0) { this.free--; return release; }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        rank,
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
/**
 * Large checkouts are written by many processes each and a few at a time, those somebody has work to do in first
 * and the others in about the order they were asked for: the worktrees of a swarm then become ready one after
 * another from the first minute, not all at the end.
 */
const largeCheckouts = new Slots(WORKSPACE_LARGE_CHECKOUTS);
/** Detaches the HEAD of a checkout where it stands. It writes that one file: the index and the files stay as they are. */
const DETACH = ['update-ref', '--no-deref', '-m', 'bridge-workflow: taken off the landing branch, which only the landing queue moves', 'HEAD', 'HEAD'];

/** A submission waiting for a train: the member's commits `base..head`, already rebased onto the branch as it was then. */
interface Candidate { ws: WorkspaceBinding; base: string; head: string; commits: number; ctx: WorkspaceContext; resolve(report: LandReport): void; reject(error: unknown): void;
  /** When it joined the queue. */
  queued: number;
  /** Takes what the main agent should hear about the branch while the submission waits (see `LandInput`). */
  noticed?: (notice: string, halted: boolean) => void;
  /** The queue has answered it; a train that runs again leaves it out. `outcome` is the status it was answered with, or `failed`. */
  settled?: boolean; outcome?: string;
  /** What it is for and whose it is, for the ledger and for what the main agent is told. */
  label?: LandLabel }
/** A Git command that failed. In a train's worktree that is the train's trouble, not that of the submissions it carries. */
class GitFailure extends Error {}
/** The landing branch moved while a train's checks ran, so what they passed on is no longer what would land. */
class BranchMoved extends Error {}
/** The landing branch is somewhere the queue cannot accept; its submissions wait until the main agent has settled it. */
class LandingHalted extends Error { constructor(readonly notice: string) { super(notice); } }
/** A submission was withdrawn from a train that had stacked it: the train stops and runs again without it. */
class Restacked extends Error {}
/** A train that failed for a reason of its own and runs again with the same submissions. */
interface TrainTrouble { failures: number; since: number; reason: string; repeated: boolean; mended?: string }
/**
 * The run a train is on: the submissions it took from the queue and how far it has come with them. `stack` holds the
 * ones whose commits are in what the checks run on; withdrawing one of those aborts `stop`, which ends the check that
 * runs. `held` are the ones that put nothing on the stack, because the submissions below them hold all of their commits
 * already, each with how many are below it. Once the step is `landing` the branch is being moved and nothing can be
 * taken back. `probes` are the runs of the checks so far, for the ledger; `base` and `head` are where the branch was
 * and where the train moved it.
 */
interface TrainRun { batch: Candidate[]; since: number; step: 'stacking' | 'checking' | 'landing'; checks: number;
  stack: Candidate[]; held: Map<Candidate, number>; stop: AbortController; probes: LandingTrain['checks']; base?: string | null; head?: string;
  /** The digest of the check commands it ran: how long a check usually takes is only said of runs under the same ones. */
  checked?: string;
  /** The run of the checks that is going on, for whoever watches the queue (see `LandingLive`). */
  checking?: { submissions: number; since: number } }
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
interface LandInput { workspace: string; taskId: string;
  /** May answer with what the commits are for and whose they are (see `LandLabel`). */
  submitted?: (info: LandSubmitted) => LandLabel | void;
  /** `halted` says the notice is that the branch is halted, which stands until the main agent settles the branch. */
  noticed?: (notice: string, halted: boolean) => void }

/**
 * How long a train waits before it runs again or looks at a halted branch again, when a lock nobody releases counts as
 * abandoned, and how much longer than usual a run of the checks takes before the main agent is told (see limits.ts).
 */
export interface TrainTiming { retryDelaysMs: readonly number[]; staleLockMs: number; haltPollMs: number; slowCheckFactor: number; slowCheckExtraMs: number }
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
  /** The worktrees whose files are being written and how to stop each; `unwatched` when no creation waits for it. */
  private readonly making = new Map<string, { workflow: string; done: Promise<WorkspaceBinding>; stop: AbortController; unwatched: boolean }>();
  /** Why the files of a worktree no creation waited for could not be written, until whoever is bound to it is told. */
  private readonly failed = new Map<string, string>();
  /** Worktrees known to be ready: asked how one stands on every scheduling pass, the service reads its record once. */
  private readonly readied = new Set<string>();
  /** Called when a worktree nobody waited for is ready or has failed, so that whoever is held back for it looks again. */
  private readonly watchers = new Set<() => void>();
  /** The worktrees each workflow wants written before its others, with their place in that order (see `want`). */
  private readonly wanted = new Map<string, Map<string, number>>();
  /** How many callers are waiting for each worktree's files right now. */
  private readonly awaited = new Map<string, number>();
  /** What `mirror` last wrote for each train, and whose queue it is once the train holds no submission to tell by. */
  private readonly lives = new Map<string, { workflow: string; repository: string; data: string }>();
  private closed = false;
  private readonly timing: TrainTiming;
  /** The workspaces that wsfs serves from the object database, for `isolation: "wsfs"`. */
  private readonly mounts: WsfsMounts;
  /** Whether this Git stacks commits without a worktree (`merge-tree --merge-base`, Git 2.40); found out on first use. */
  private grafts = true;
  /** Git for `writeCheckout`; one function for the life of the service, which is what it remembers this Git by. */
  private readonly checkoutGit: CheckoutGit = (cwd, args, signal, env) => this.git(cwd, args, signal, false, env);

  constructor(path: string, private readonly directory: string, private readonly processes: WorkflowProcesses = nodeProcesses, timing: Partial<TrainTiming> = {}) {
    this.timing = { retryDelaysMs: TRAIN_RETRY_DELAYS_MS, staleLockMs: TRAIN_STALE_LOCK_MS, haltPollMs: TRAIN_HALT_POLL_MS,
      slowCheckFactor: TRAIN_SLOW_CHECK_FACTOR, slowCheckExtraMs: TRAIN_SLOW_CHECK_EXTRA_MS, ...timing };
    this.mounts = new WsfsMounts(directory, processes);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_records (
      id TEXT PRIMARY KEY, workflow TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
      digest TEXT NOT NULL, done INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL,
      UNIQUE(workflow,key));`);
    // The landing ledger: one row for each run of a train (see `LandingTrain`).
    this.db.exec(`CREATE TABLE IF NOT EXISTS landing_trains (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow TEXT NOT NULL, repository TEXT NOT NULL, since INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS landing_trains_by_repository ON landing_trains(workflow, repository, id);`);
    // The landing queues as they stand (see `LandingLive`). A queue does not outlive its service, so none stands now.
    this.db.exec(`CREATE TABLE IF NOT EXISTS landing_live (
      workflow TEXT NOT NULL, repository TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workflow, repository));
      DELETE FROM landing_live;`);
    // The daemons of wsfs workspaces outlive this service and are looked after by whichever one runs.
    const served = this.db.prepare("SELECT data FROM workspace_records WHERE kind='workspace' AND json_extract(data,'$.isolation')='wsfs' AND COALESCE(json_extract(data,'$.status'),'')!='removed'").all() as Array<{ data: string }>;
    for (const row of served) this.mounts.know(JSON.parse(row.data) as WorkspaceBinding);
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
  private putWorkspace(workspace: WorkspaceBinding): void {
    if (workspace.status !== 'ready') this.readied.delete(workspace.id);
    this.save(this.row(workspace.id, workspace.workflowId, 'workspace'), workspace);
  }

  private async git(cwd: string, args: string[], signal: AbortSignal, allowFailure = false, env?: NodeJS.ProcessEnv, output?: CommandOutput): Promise<CommandResult> {
    const hooks = join(this.directory, 'empty-hooks'); await mkdir(hooks, { recursive: true, mode: 0o700 });
    // Git's own options (`-c name=value`) come before the subcommand.
    const name = `git ${args.find((arg, at) => !arg.startsWith('-') && args[at - 1] !== '-c') ?? ''}`.trim();
    const result = await workspaceCommand('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false',
      '-c', 'gc.auto=0', ...args], cwd, signal, GIT_TIMEOUT_MS, { ...gitEnv(), ...env }, this.processes, { name, ...output });
    // A Git that was killed prints nothing: how it ended is then all there is to say of it.
    if (result.code && !allowFailure) throw new GitFailure(`Git ${name.slice(4) || args[0]} failed: ${(result.stderr || result.stdout
      || (result.signal ? `killed by ${result.signal}` : `exit code ${result.code}`)).slice(0, 1600)}`);
    return result;
  }
  private async worktree(ws: Pick<WorkspaceBinding, 'repository' | 'commonDir'>, args: string[], signal: AbortSignal, allowFailure = false, rank?: () => number): Promise<CommandResult> {
    let turns = worktreeCommands.get(ws.commonDir);
    if (!turns) worktreeCommands.set(ws.commonDir, turns = new Slots(1));
    const release = await turns.acquire(signal, rank);
    try {
      return await this.git(ws.repository, ['worktree', ...args], signal, allowFailure);
    } finally {
      release();
      if (turns.idle && worktreeCommands.get(ws.commonDir) === turns) worktreeCommands.delete(ws.commonDir);
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
    await this.git(path, ['status', '--porcelain', `--untracked-files=${untracked}`], signal, false, undefined,
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
  origin(workflowId: string, id: string): { repo: string; isolation?: 'clone' | 'wsfs' } {
    const ws = this.value<WorkspaceBinding>(id, workflowId, 'workspace');
    return { repo: ws.repository, ...(ws.isolation ? { isolation: ws.isolation } : {}) };
  }

  async binding(root: WorkflowRoot, workflowId: string, id: string, signal: AbortSignal): Promise<WorkspaceBinding> {
    const ws = this.value<WorkspaceBinding>(id, workflowId, 'workspace');
    if (ws.rootDigest === workflowDigest(root) && ws.status === 'preparing') throw new Error('Workspace is still being prepared');
    if (ws.rootDigest !== workflowDigest(root) || ws.status !== 'ready') throw new Error('Workspace binding is unavailable or authorization changed');
    return this.located(ws, signal);
  }
  /**
   * Where a workspace is, under `directory`: this service derives the path and never takes one read back. A wsfs
   * workspace is a directory of the mount its workflow has for the repository.
   */
  private home(ws: Pick<WorkspaceBinding, 'workflowId' | 'id' | 'commonDir' | 'isolation'>, directory = resolve(this.directory)): string {
    return ws.isolation === 'wsfs' ? this.mounts.path(ws, directory) : join(directory, ws.workflowId, ws.id);
  }
  /** Checks that the directory is the workspace's own checkout of its repository, served again first when wsfs serves it. */
  private async located(ws: WorkspaceBinding, signal: AbortSignal): Promise<WorkspaceBinding> {
    // The daemon that serves the workspace may have died since it was last used; whoever is bound to it finds it served.
    if (ws.isolation === 'wsfs') await this.mounts.serve(ws);
    const top = await realpath((await this.git(ws.path, ['rev-parse', '--show-toplevel'], signal)).stdout.trim());
    const common = await realpath(resolve(ws.path, (await this.git(ws.path, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()));
    if (top !== await realpath(ws.path) || common !== (ws.isolation === 'clone' ? join(top, '.git') : ws.commonDir)
      || top !== this.home(ws, await realpath(this.directory))) throw new Error('Workspace path or repository identity changed');
    return ws;
  }

  /** Has `listener` called when a worktree no creation waited for is ready or has failed. */
  watch(listener: () => void): void { this.watchers.add(listener); }
  /**
   * How a worktree stands for a member that is bound to it and has yet to work in it: its files are there, they are
   * being written, or they could not be written. A failure is told once, to whoever stops the member for it; asked
   * again, as after the member is revived, the files are written anew. So are those of a worktree nobody is writing,
   * which is how a restart of the service leaves one. `allowed` is the host's check that the root may still have it made.
   */
  standing(root: WorkflowRoot, workflowId: string, id: string, allowed?: () => Promise<void>): 'ready' | 'preparing' | { failed: string } {
    if (this.readied.has(id)) return 'ready';
    const row = this.db.prepare("SELECT * FROM workspace_records WHERE id=? AND workflow=? AND kind='workspace'").get(id, workflowId) as RecordRow | undefined;
    if (!row) return { failed: 'Unknown workspace' };
    const ws = JSON.parse(row.data) as WorkspaceBinding;
    if (ws.status === 'ready') { this.readied.add(id); return 'ready'; }
    if (ws.status === 'removed') return { failed: 'Workspace was removed' };
    if (this.making.has(id) || this.closed) return 'preparing';
    const failure = this.failed.get(id);
    if (failure !== undefined) { this.failed.delete(id); return { failed: failure }; }
    if (ws.rootDigest !== workflowDigest(root)) return { failed: 'Workspace authorization changed' };
    // An integration is checked out at a commit of its own, by the operation that prepares it.
    const op = ws.kind === 'integration' ? undefined
      : this.db.prepare('SELECT * FROM workspace_records WHERE id=? AND workflow=?').get(row.key.slice(1, row.key.indexOf('/')), workflowId) as RecordRow | undefined;
    if (!op) return { failed: 'Workspace was not prepared' };
    void this.make(op, ws, ws.baseCommit, undefined, allowed).catch(() => undefined);
    return 'preparing';
  }
  /** Whether the worktree is this root's and its files are still to be written. */
  preparing(root: WorkflowRoot, workflowId: string, id: string): boolean {
    const ws = this.value<WorkspaceBinding>(id, workflowId, 'workspace');
    return ws.rootDigest === workflowDigest(root) && ws.status === 'preparing';
  }
  /** The worktree once its files are there: waits out a creation that did not wait, and fails as that failed. */
  async prepared(root: WorkflowRoot, workflowId: string, id: string, signal: AbortSignal, allowed?: () => Promise<void>): Promise<WorkspaceBinding> {
    for (;;) {
      signal.throwIfAborted();
      const found = this.standing(root, workflowId, id, allowed);
      if (found === 'ready') return this.binding(root, workflowId, id, signal);
      if (found !== 'preparing') throw new Error('Workspace could not be prepared: ' + found.failed);
      const under = this.making.get(id);
      if (!under) throw new Error('Workspace service is closed');
      let wake!: () => void;
      const aborted = new Promise<void>(done => { wake = done; });
      signal.addEventListener('abort', wake, { once: true });
      // Somebody is held up by this worktree, so it is written before those nobody is waiting for.
      this.awaited.set(id, (this.awaited.get(id) ?? 0) + 1);
      try { await Promise.race([under.done.then(() => undefined, () => undefined), aborted]); } finally {
        signal.removeEventListener('abort', wake);
        const others = this.awaited.get(id)! - 1;
        if (others) this.awaited.set(id, others); else this.awaited.delete(id);
      }
    }
  }
  /**
   * Names the worktrees of a workflow to write first, most urgent first: those of the members that have something to
   * do and are held back only by their worktree. It replaces what the workflow named before. The others follow in
   * the order they were asked for, so nothing waits idle for a turn that somebody with work could use.
   */
  want(workflowId: string, ids: readonly string[]): void {
    if (ids.length) this.wanted.set(workflowId, new Map(ids.map((id, at) => [id, at]))); else this.wanted.delete(workflowId);
  }
  /** Where a worktree stands among those waiting to be written: lower is sooner. */
  private urgency(workflowId: string, id: string): number {
    return this.awaited.has(id) ? -1 : this.wanted.get(workflowId)?.get(id) ?? Infinity;
  }
  /**
   * Stops writing worktrees no creation waits for unless their workflow is among `kept`, which is asked for only
   * when there are any: a workflow that was cancelled or has ended would otherwise keep the checkouts of those that
   * run waiting. What was written stays, and is finished if the worktree is ever asked for again.
   */
  abandon(kept: () => ReadonlySet<string>): void {
    this.mounts.tend(kept);
    let live: ReadonlySet<string> | undefined;
    for (const entry of this.making.values()) {
      if (entry.unwatched && !(live ??= kept()).has(entry.workflow)) entry.stop.abort(new Error('Workflow is no longer running'));
    }
    for (const workflow of this.wanted.keys()) if (!(live ??= kept()).has(workflow)) this.wanted.delete(workflow);
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

  /**
   * Records the worktree a creation makes and writes its files. With `defer` it answers as soon as the record exists,
   * the worktree still being prepared: whoever is bound to it is held back until `standing` says its files are there.
   */
  private async materialize(ctx: WorkspaceContext, op: RecordRow, seed: { repository: string; commonDir: string; baseCommit: string; kind: WorkspaceBinding['kind']; isolation?: 'clone' | 'wsfs'; changeId?: string }, checkout = seed.baseCommit, defer = false): Promise<WorkspaceBinding> {
    // Removed worktrees are kept as records for replay and audit, but they no longer hold a directory or a slot.
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE workflow=? AND kind='workspace' AND COALESCE(json_extract(data,'$.status'),'')!='removed'").get(op.workflow) as { n: number }).n;
    const existing = this.db.prepare('SELECT id FROM workspace_records WHERE workflow=? AND key=?').get(op.workflow, `@${op.id}/workspace`);
    if (!existing && count >= MAX_WORKSPACES) throw new Error(`Workspace budget reached (${MAX_WORKSPACES} per workflow)`);
    const ws = this.internal<WorkspaceBinding>(op, 'workspace', 'workspace', id => ({ id, workflowId: op.workflow,
      rootDigest: workflowDigest(ctx.state.root), path: this.home({ workflowId: op.workflow, id, commonDir: seed.commonDir, isolation: seed.isolation }), status: 'preparing', ...seed }));
    if (ws.status === 'removed') throw new Error('Workspace was removed; use a new workspace key');
    if (ws.status === 'ready') {
      const bound = await this.binding(ctx.state.root, op.workflow, ws.id, ctx.signal);
      if ((await this.clean(bound, ctx.signal)).headCommit !== checkout) throw new Error('Recovered worktree does not match its planned revision');
      return bound;
    }
    if (!defer) return this.make(op, ws, checkout, ctx.signal);
    void this.make(op, ws, checkout).catch(() => undefined);
    return ws;
  }
  /**
   * Writes the files of a worktree that is recorded as being prepared and marks it ready, once however many ask for
   * it. A creation that waits gives its signal and hears how it went. One that does not leaves the work to run until
   * the service closes, the worktree is cleaned up or its workflow is given up (`abandon`); how it went is what
   * `standing` tells whoever is bound to the worktree.
   */
  private make(op: RecordRow, ws: WorkspaceBinding, checkout: string, signal?: AbortSignal, allowed?: () => Promise<void>): Promise<WorkspaceBinding> {
    const under = this.making.get(ws.id);
    if (under) return under.done;
    const stop = new AbortController();
    const ends = AbortSignal.any([stop.signal, this.stopping.signal, ...(signal ? [signal] : [])]);
    // A creation somebody waits for goes before the others; so does a worktree a member with work is waiting for.
    const rank = signal ? () => -1 : () => this.urgency(op.workflow, ws.id);
    const done = (async () => {
      // Started from a look at how the worktree stands, which cannot wait for the host's answer itself.
      await allowed?.();
      ends.throwIfAborted();
      // wsfs writes an index and no file of the checkout: the workspace shows the commit as its daemon reads it from
      // the object database, so nothing waits for a turn to write here and nothing is left to compare afterwards.
      let written = true;
      if (ws.isolation === 'wsfs') await this.mounts.create(ws, checkout, ends);
      else {
        await mkdir(dirname(ws.path), { recursive: true, mode: 0o700 });
        if (ws.isolation === 'clone') await this.clone(ws, checkout, ends);
        else {
          // `worktree add` writes the `.git` file before it points HEAD at the commit. One that was stopped in between
          // left a worktree no later command completes; it holds no work yet, so it is registered again. Forced twice,
          // Git registers over what is left of a locked worktree whose directory is gone.
          const registered = await access(join(ws.path, '.git')).then(() => true, () => false);
          const whole = registered && (await this.git(ws.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], ends, true)).stdout.trim() === checkout;
          if (registered && !whole) await rm(ws.path, { recursive: true, force: true });
          // Only registration races with other Git commands; leave `worktree add` cheap and write the files separately.
          if (!whole) await this.worktree(ws, ['add', '--force', '--force', '--no-checkout', '--detach', '--lock', '--reason', `bridge-workflow:${ws.id}`, ws.path, checkout], ends, false, rank);
        }
        written = await this.writeTree(ws.path, checkout, ends, rank);
      }
      // Ready is what lets a member start in it, so it is said only of a checkout that was found to be the planned one.
      // One that many processes wrote was found so as they wrote it. Reading the status of every file again takes a
      // process of its own longer than writing them took all of those, with the next checkouts being written beside it.
      await this.located(ws, ends);
      if ((written ? await this.revision(ws.path, undefined, ends) : (await this.clean(ws, ends)).headCommit) !== checkout) throw new Error('Recovered worktree does not match its planned revision');
      ends.throwIfAborted();
      const ready: WorkspaceBinding = { ...ws, status: 'ready' };
      this.putWorkspace(ready);
      // A creation that did not wait has nobody else to record that it is finished.
      const row = signal ? undefined : this.row(op.id, op.workflow);
      if (row && !row.done) this.save(row, ready, 1);
      return ready;
    })();
    const entry = { workflow: op.workflow, done, stop, unwatched: !signal };
    this.making.set(ws.id, entry); this.pending.add(done); this.failed.delete(ws.id);
    void done.then(() => undefined, error => {
      // Stopped on purpose is not a failure of the worktree: whoever looks at it next has its files written again.
      if (entry.unwatched && !ends.aborted) this.failed.set(ws.id, error instanceof Error ? error.message : String(error));
    }).finally(() => {
      this.pending.delete(done);
      if (this.making.get(ws.id) === entry) this.making.delete(ws.id);
      if (entry.unwatched) for (const watcher of this.watchers) watcher();
    });
    return done;
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
    if (ws.isolation !== 'clone' || ws.path !== this.home(ws)) throw new Error('Not a managed clone');
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
   * so filters and modes match, and repeating it on a worktree whose files are already there changes nothing. A large
   * checkout is first offered to `writeCheckout`, which has many processes write it, one checkout at a time. Returns
   * whether that wrote it: every file of the commit is then known to be there as Git wrote it (see `writeCheckout`).
   */
  private async writeTree(path: string, commit: string, signal: AbortSignal, rank?: () => number): Promise<boolean> {
    let release = await checkoutSlots.acquire(signal, rank), large = false;
    try { large = await largeCheckout(this.checkoutGit, path, commit, signal); } finally { release(); }
    if (large) {
      // Only a large checkout waits its turn here: a small one is not kept behind the minutes several of these take.
      release = await largeCheckouts.acquire(signal, rank);
      try { if (await writeCheckout(this.checkoutGit, path, commit, WORKSPACE_CHECKOUT_PROCESSES, signal)) return true; } finally { release(); }
    }
    release = await checkoutSlots.acquire(signal, rank);
    try { await this.git(path, ['read-tree', '--reset', '-u', commit], signal); } finally { release(); }
    return false;
  }

  perform(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Workspace service is closed'));
    const pending = this.performInner(ctx, input); this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  private async performInner(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<unknown> {
    const { kind, key, wait, ...args } = input;
    const allowed: Record<string, string[]> = { create: ['base', 'change', 'repo', 'isolation'], freeze: ['workspace'], approve: ['change', 'taskId'],
      integrate: ['base', 'approvals', 'target'], landing: ['checks', 'target', 'precheck', 'protect', 'batch'], check: ['workspace', 'commands'], accept: ['workspace', 'checks'], cleanup: ['workspace'] };
    if (!Object.hasOwn(allowed, String(kind)) || Object.keys(args).some(key => !allowed[String(kind)]!.includes(key))) throw new Error('Unsupported workspace operation or option');
    // Whether the caller waits for the files says nothing about the worktree: the same key asks for the same one either way.
    if (wait !== undefined && (kind !== 'create' || typeof wait !== 'boolean')) throw new Error('wait is true or false, and only a creation takes it');
    const defer = wait === false;
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
      try { result = await this.apply(ctx, op, String(kind), args, defer); } catch (error) {
        // Kept, the record of a creation that failed over its inputs refuses the key to any other input while the same
        // input fails again: a member that staff_swarm could not give a worktree could never be added under its name.
        if (kind === 'create' && this.unmade(op)) this.forget(op);
        throw error;
      }
      ctx.signal.throwIfAborted();
      // A worktree that is still being prepared is recorded as made by whoever writes its files (see `make`).
      if (!(defer && (result as WorkspaceBinding).status === 'preparing')) this.save(op, result, 1);
      return result;
    } finally { this.activeKeys.delete(lock); }
  }

  private async apply(ctx: WorkspaceContext, op: RecordRow, kind: string, args: Record<string, unknown>, defer = false): Promise<unknown> {
    const id = (value: unknown) => scriptText(value, 'artifact ID', 100);
    if (kind === 'create') {
      if (args.change !== undefined && (args.base !== undefined || args.repo !== undefined || args.isolation !== undefined)) throw new Error('Choose base, repo and isolation, or change');
      if (args.isolation !== undefined && args.isolation !== 'worktree' && args.isolation !== 'clone' && args.isolation !== 'wsfs') throw new Error('isolation is "worktree", "clone" or "wsfs"');
      const isolation: { isolation?: 'clone' | 'wsfs' } = args.isolation === 'clone' || args.isolation === 'wsfs' ? { isolation: args.isolation } : {};
      if (args.change !== undefined) {
        const change = this.value<WorkspaceChange>(id(args.change), op.workflow, 'change');
        const source = this.value<WorkspaceBinding>(change.workspaceId, op.workflow, 'workspace');
        await this.supportedTree(source.repository, change.headCommit, ctx.signal);
        return this.materialize(ctx, op, { repository: source.repository, commonDir: source.commonDir, baseCommit: change.headCommit, kind: 'review', changeId: change.id }, change.headCommit, defer);
      }
      const prior = JSON.parse(op.data) as { repository?: string; commonDir: string; baseCommit: string };
      let seed;
      if (prior.repository) seed = { repository: prior.repository, commonDir: prior.commonDir, baseCommit: prior.baseCommit };
      else {
        const repo = await this.repository(ctx.state.root, ctx.signal, args.repo);
        const dirty = await this.uncommitted(repo.repository);
        // Whoever is refused is often not who left the files there: it is told which ones stand in the way and where.
        if (dirty.count) throw new Error(`Authorized checkout has uncommitted changes (${dirty.first.join(', ')}${dirty.count > 5 ? `, and ${dirty.count - 5} more` : ''}, in ${repo.repository}); choose a clean committed baseline first`);
        // A clone reads the source's objects from disk, and so does wsfs; ones a partial clone would fetch on demand are not there.
        if (isolation.isolation && (await this.git(repo.repository, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], ctx.signal, true)).stdout.trim()) throw new Error(`${isolation.isolation === 'wsfs' ? 'wsfs' : 'Clone'} workspaces do not support partial-clone repositories`);
        // Refused before anything is recorded when wsfs cannot serve this repository here, so the key stays free for another isolation.
        if (isolation.isolation === 'wsfs') await this.servable(repo, ctx.signal);
        seed = { ...repo, baseCommit: await this.revision(repo.repository, args.base, ctx.signal) }; this.save(op, seed);
      }
      await this.supportedTree(seed.repository, seed.baseCommit, ctx.signal);
      return this.materialize(ctx, op, { ...seed, kind: 'task', ...isolation }, seed.baseCommit, defer);
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
    // Freezing or checking a worktree whose files are still being written waits for them.
    const ws = this.preparing(ctx.state.root, op.workflow, id(args.workspace)) ? await this.prepared(ctx.state.root, op.workflow, id(args.workspace), ctx.signal)
      : await this.binding(ctx.state.root, op.workflow, id(args.workspace), ctx.signal);
    this.idle(ws, ctx);
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
    if (ws.status === 'preparing') {
      // Whoever is writing its files is stopped first, and waited for: the directory is not deleted under it.
      const under = this.making.get(ws.id);
      if (under) { under.stop.abort(new Error('Workspace was cleaned up')); await under.done.catch(() => undefined); }
      ws = this.value<WorkspaceBinding>(workspaceId, op.workflow, 'workspace');
    }
    if (ws.status === 'preparing') {
      // Nobody has worked in a worktree whose files were never all there, so whatever was made of it goes.
      this.idle(ws, ctx);
      this.failed.delete(ws.id);
      this.save(op, { removing: true });
      if (ws.isolation) await this.drop(ws, ctx.signal);
      else if (await access(join(ws.path, '.git')).then(() => true, () => false)) {
        const unlock = await this.worktree(ws, ['unlock', ws.path], ctx.signal, true);
        if (unlock.code && !unlock.stderr.includes('not locked')) throw new Error('Cannot unlock worktree');
        await this.worktree(ws, ['remove', '--force', ws.path], ctx.signal);
      } else await rm(ws.path, { recursive: true, force: true, maxRetries: 3 });
      this.putWorkspace({ ...ws, status: 'removed' });
      return { workspace: ws.id, removed: true };
    }
    // A clone or a wsfs workspace whose removal was interrupted may be half deleted; nothing in it is needed, so the removal is finished.
    if (intent.removing && (ws.isolation || !await access(ws.path).then(() => true, () => false))) {
      if (ws.busy && ws.busy.token !== intent.token) throw new Error('Workspace execution ownership changed');
      if (ws.isolation) await this.drop(ws, ctx.signal);
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
      // Cleanup discards the directory, uncommitted and unintegrated changes included: a member that cannot be
      // revived is better redone than kept around for work nobody may ever land.
      this.save(op, { removing: true, token });
      if (ws.isolation) await this.drop(ws, ctx.signal);
      else {
        const unlock = await this.worktree(ws, ['unlock', ws.path], ctx.signal, true);
        if (unlock.code && !unlock.stderr.includes('not locked')) throw new Error('Cannot unlock worktree');
        await this.worktree(ws, ['remove', '--force', ws.path], ctx.signal);
      }
      this.putWorkspace({ ...ws, status: 'removed', busy: { token, ownerPid: process.pid } });
      if (ws.kind === 'task') await this.retireTrain(ws, ctx.signal);
      return { workspace: ws.id, removed: true };
    } finally { this.end(ws, token); }
  }

  /** Removes a workspace that is not a plain worktree, with everything in it. */
  private async drop(ws: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    // wsfs removes the workspace's files and its worktree record, and stops serving once its mount has no workspace.
    if (ws.isolation === 'wsfs') { await this.mounts.remove(ws, signal); return; }
    // What the clone landed or froze is held by other refs.
    await this.removeClone(ws);
    await this.git(ws.repository, ['update-ref', '-d', this.cloneRef(ws)], signal, true);
  }
  /** What wsfs cannot serve, of a repository that workspaces are about to be made from. */
  private async servable(repo: { repository: string; commonDir: string }, signal: AbortSignal): Promise<void> {
    await this.mounts.available();
    if ((await this.git(repo.repository, ['rev-parse', '--show-object-format'], signal)).stdout.trim() !== 'sha1') throw new Error('wsfs workspaces need a SHA-1 repository');
    // The workspace is a linked worktree and reads the repository's shared configuration. Git would leave files out
    // of one it takes for sparse, and wsfs shows every file of the commit.
    if ((await this.git(repo.repository, ['config', '--file', join(repo.commonDir, 'config'), '--type=bool', '--default=false', '--get', 'core.sparseCheckout'], signal, true)).stdout.trim() === 'true') throw new Error('wsfs workspaces do not support a repository whose shared configuration turns sparse checkout on');
  }
  /**
   * Moves a workspace to `commit` as `git reset --hard` does, HEAD included. In a wsfs workspace whose HEAD is detached
   * the daemon does it and no file is written: through the mount Git would write every file that differs, and the
   * workspace would keep them all. Anything else is Git's own reset in the workspace, as is a move the daemon
   * refused before it changed anything. A workspace that is on the landing branch is taken off it first: the reset
   * would move the branch with it, and only the queue moves that.
   */
  private async reset(ws: WorkspaceBinding, commit: string, signal: AbortSignal): Promise<void> {
    const on = ws.isolation === 'clone' ? undefined : await this.git(ws.path, ['symbolic-ref', '--quiet', 'HEAD'], signal, true);
    let detached = on?.code === 1;
    if (on && !on.code && on.stdout.trim() === this.landing(ws.workflowId)?.targetRef) { await this.git(ws.path, DETACH, signal); detached = true; }
    if (ws.isolation === 'wsfs' && detached) {
      const moved = await this.mounts.move(ws, commit, signal);
      if (moved) return;
    }
    await this.git(ws.path, ['reset', '--hard', '--quiet', commit], signal);
  }
  /**
   * Rebases the commits of a workspace onto `onto` without writing a file: they are stacked in the object database
   * (see `graft`), and the workspace stays where it is until the caller moves it to the result. A rebase by Git in
   * the workspace rewrites the index and, for each commit, every file that differs between the two branch heads; in
   * a wsfs workspace those go through the mount, and the workspace then keeps them all. Returns nothing when this is
   * not the way to do it here (a wsfs workspace with HEAD on a branch, which only Git moves; commits that are no plain
   * line), and the caller has Git rebase in the workspace.
   */
  private async rebased(ws: WorkspaceBinding, head: string, onto: string, signal: AbortSignal): Promise<{ head: string } | { conflict: string } | undefined> {
    if (ws.isolation === 'wsfs' && (await this.git(ws.path, ['symbolic-ref', '--quiet', 'HEAD'], signal, true)).code !== 1) return undefined;
    // A clone's commits are in its own object store, which also reads the source's; the others share the source's.
    const repo = ws.isolation === 'clone' ? ws.path : ws.repository;
    const base = (await this.git(repo, ['merge-base', head, onto], signal, true)).stdout.trim();
    if (!SHA.test(base)) return undefined;
    return this.graft(repo, onto, { base, head }, await this.identity(ws.path, signal), signal);
  }
  /**
   * The ref that keeps the commits of a submission in the source repository while the landing queue answers for them:
   * the member's worktree has gone back to the branch, so nothing else names them. It is dropped when they land. The
   * ref of commits the queue turned back stays, for claim_work to put them into the worktree of whoever takes the item.
   */
  private workRef(ws: Pick<WorkspaceBinding, 'workflowId'>, head: string): string { return `refs/bridge-workflow/${ws.workflowId}/work/${head}`; }

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
  /**
   * Takes the landing branch from every checkout that is on it, before the queue moves it: HEAD stays on the commit
   * it was on, detached, and neither the index nor a file is touched. The branch is the queue's, and a member that
   * switched to it does not hold up what everyone else submitted. Left on the branch, its checkout would show all
   * that lands as a staged change that undoes it, and its next commit would take that work out of the branch again.
   * A checkout whose HEAD cannot be written is left as it is, and the branch moves all the same.
   */
  private async takeBack(ws: WorkspaceBinding, ref: string, signal: AbortSignal): Promise<void> {
    for (const entry of (await this.worktree(ws, ['list', '--porcelain'], signal)).stdout.split('\n\n')) {
      const lines = entry.split('\n'), path = lines.find(line => line.startsWith('worktree '))?.slice(9);
      if (path && lines.includes(`branch ${ref}`)) await this.git(path, DETACH, signal, true).catch(() => undefined);
    }
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
   * commits are stacked on the branch in the object database, screened for protected paths and, when the workflow has
   * a precheck, checked in the worktree on their own, side by side with other members; what fails there is the
   * answer, with the worktree as the member left it or, after a precheck, on the stacked commits. Then the commits
   * join the queue by their IDs under a ref of their own, `submitted` is called, and the worktree goes back to the tip
   * of the branch for the member's next item: the queue does not look at it again. The promise settles with what the
   * queue made of the commits (see `round`), which may be much later.
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
    // `head` is what is submitted, `at` where the worktree stands: the commits are stacked on the branch in the object
    // database, and the worktree follows only when the precheck has to run on them.
    let head = before.headCommit, at = head;
    if (!await ancestor(targetCommit, head)) {
      const stacked = await this.rebased(ws, head, targetCommit, signal);
      if (stacked && 'conflict' in stacked) return { status: 'conflict', targetRef, targetCommit, detail: stacked.conflict };
      if (stacked) head = stacked.head;
      else {
        const undo = () => this.git(ws.path, ['rebase', '--abort'], new AbortController().signal, true);
        const rebased = await this.git(ws.path, [...await this.identity(ws.path, signal), 'rebase', targetCommit], signal, true, undefined, { keep: 'tail' }).catch(async error => { await undo(); throw error; });
        if (rebased.code) await undo();
        if (rebased.code) return { status: 'conflict', targetRef, targetCommit, detail: (rebased.stdout + rebased.stderr).slice(-4000) };
        head = at = (await this.clean(ws, signal)).headCommit;
      }
    }
    const quiet = new AbortController().signal;
    if (head === targetCommit) {
      // The branch holds all of it already: the worktree goes there, as after a landing.
      if (at !== head) await this.reset(ws, targetCommit, quiet).catch(() => {});
      return nothing;
    }
    if (landing.protect) {
      const barred = landing.protect.filter(rule => !rule.allow.includes(ws.id)).flatMap(rule => rule.paths.map(pathPattern));
      const { count, files } = await this.touched(ws.path, targetCommit, head, barred, signal);
      if (count) return { status: 'rejected', targetRef, targetCommit, files,
        reason: `${count} changed path(s) are protected from this worktree; resubmit commits that leave them as they are on the landing branch` };
    }
    if (landing.precheck) {
      if (at !== head) { await this.reset(ws, head, signal); at = head; }
      const commands = tail(await this.run(ws.path, landing.precheck, signal, ctx.state.deadlineAt));
      const failed = { status: 'check_failed' as const, targetRef, targetCommit, headCommit: head, commands };
      if (commands.length !== landing.precheck.length || commands.some(result => result.code)) return failed;
      const after = await this.clean(ws, signal).catch((error: Error) => error.message);
      if (typeof after === 'string') return { ...failed, reason: after };
      if (after.headCommit !== head) return { ...failed, reason: 'Checks changed the worktree HEAD' };
    }
    const commits = Number((await this.git(ws.path, ['rev-list', '--count', `${targetCommit}..${head}`], signal)).stdout.trim());
    await this.publish(ws, head, signal);
    await this.git(ws.repository, ['update-ref', this.workRef(ws, head), head], signal);
    signal.throwIfAborted();
    // The queue takes the commits by their IDs. The worktree starts the member's next item where a landing would
    // leave it: at the tip of the branch, without commits that may yet be turned back. One that cannot be moved is
    // left to the member, which is told so.
    const moved = await this.reset(ws, targetCommit, quiet).then(() => true, () => false);
    flight.detach();
    let label: LandLabel | undefined;
    try { label = input.submitted?.({ targetRef, targetCommit, headCommit: head, commits, worktree: moved ? 'reset' : 'kept' }) || undefined; }
    catch (error) {
      // Nobody answers for the commits (the claim they were submitted for ended meanwhile, say). The queue does not
      // take them, and the worktree gets them back for whoever works there next.
      const back = !moved || await this.reset(ws, head, quiet).then(() => true, () => false);
      await this.git(ws.repository, ['update-ref', '-d', this.workRef(ws, head)], quiet, true).catch(() => {});
      if (back) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)}. The commits are ${targetCommit}..${head}, and the worktree was moved back to ${targetCommit}: git cherry-pick brings them back`);
    }
    const boarded = this.board({ ws, base: targetCommit, head: head, commits, ctx, ...(input.noticed ? { noticed: input.noticed } : {}), ...(label ? { label } : {}) });
    // Whoever submitted may be gone when the queue answers.
    void boarded.catch(() => {});
    return boarded;
  }
  /**
   * Puts a member's worktree where the item it has just claimed starts, so that the member neither starts on a branch
   * that has moved on nor fetches its own commits back by hand. For an item the landing queue turned back, `commits`
   * names what was submitted for it (`base..head`), and the worktree is moved onto those commits as they were
   * submitted, whoever submitted them; for any other item it is moved to the tip of the landing branch. Only a
   * worktree that loses nothing by it is moved: one with uncommitted changes, with commits that are neither on the
   * branch nor among `commits`, or in which a submission is being prepared is `kept`, and `note` says why. Resolves
   * to nothing where there is no landing to position for.
   */
  async position(ctx: WorkspaceContext, input: { workspace: string; taskId: string; commits?: string }): Promise<LandPosition | undefined> {
    const workflow = ctx.state.workflowId, { signal } = ctx;
    const landing = this.landing(workflow);
    if (!landing || this.closed) return undefined;
    const ws = await this.binding(ctx.state.root, workflow, input.workspace, signal);
    if (ws.kind !== 'task' || ws.busy?.taskId !== input.taskId) return undefined;
    const head = await this.revision(ws.path, undefined, signal);
    const kept = (note: string): LandPosition => ({ worktree: 'kept', headCommit: head, note });
    if (this.inFlight.has(`${workflow}:${input.workspace}:${input.taskId}`)) return kept('submit_work is still at work in this worktree');
    const ancestor = async (older: string, newer: string) => !(await this.git(ws.path, ['merge-base', '--is-ancestor', older, newer], signal, true)).code;
    const branch = await this.refHead(ws.repository, landing.targetRef, signal);
    // A branch that was moved from outside is not started from until the queue vouches for where it is.
    const tip = this.vouched(ws, landing.targetRef, branch)?.head ?? branch ?? ws.baseCommit;
    const returned = /^[0-9a-f]{40,64}\.\.([0-9a-f]{40,64})$/.exec(input.commits ?? '')?.[1];
    if (returned && (await this.git(ws.path, ['cat-file', '-e', `${returned}^{commit}`], signal, true)).code) return kept(`The commits ${input.commits} are not in this repository any more`);
    const want = returned ?? tip;
    if (head === want || returned && await ancestor(returned, head)) return { worktree: returned ? 'commits' : 'tip', headCommit: head };
    // What the worktree holds is on the branch, or among the commits it is given: nothing of it is left behind.
    if (!await ancestor(head, tip) && !(returned && await ancestor(head, returned))) {
      return kept(`The worktree holds commits that are not on the landing branch (HEAD ${head}), so it was left as it is. `
        + (returned ? `The commits of this item are ${input.commits}: once yours are submitted or no longer needed, git reset --hard ${returned} takes the worktree there`
          : `The tip of the landing branch is ${tip}: submit them, or git reset --hard ${tip} when they are no longer needed`));
    }
    try { await this.clean(ws, signal); }
    catch (error) { if (signal.aborted) throw error; return kept(`${error instanceof Error ? error.message : String(error)}, so the worktree was left at ${head}; ${returned ? `the commits of this item end at ${returned}` : `the tip of the landing branch is ${tip}`}`); }
    await this.reset(ws, want, signal);
    return { worktree: returned ? 'commits' : 'tip', headCommit: want };
  }
  private async identity(path: string, signal: AbortSignal): Promise<string[]> {
    return (await this.git(path, ['config', 'user.email'], signal, true)).stdout.trim() ? [] : ['-c', 'user.name=Bridge workflow', '-c', 'user.email=workflow@localhost'];
  }

  /** Queues a submission for the next train of its workflow and repository; settles when a train has dealt with it. */
  private board(change: Omit<Candidate, 'resolve' | 'reject' | 'queued'>): Promise<LandReport> {
    const key = `${change.ws.workflowId}:${change.ws.commonDir}`, { signal } = change.ctx;
    const train: Train = this.trains.get(key) ?? { queue: [], running: false }, { queue } = train;
    this.trains.set(key, train);
    return new Promise<LandReport>((resolve, reject) => {
      // A member whose turn ended leaves the queue; once on a train its work lands or fails with the rest.
      const leave = () => { const at = queue.indexOf(candidate); if (at >= 0) { queue.splice(at, 1); reject(signal.reason); this.mirror(key); } };
      const settled = <T>(settle: (value: T) => void, outcome: (value: T) => string) => (value: T) => {
        if (candidate.settled) return;
        candidate.settled = true; candidate.outcome = outcome(value); signal.removeEventListener('abort', leave); settle(value);
        if (candidate.outcome !== 'landed') return;
        // The branch holds them now.
        const dropped = this.git(change.ws.repository, ['update-ref', '-d', this.workRef(change.ws, change.head)], new AbortController().signal, true).then(() => {}, () => {});
        this.pending.add(dropped); void dropped.finally(() => this.pending.delete(dropped));
      };
      const candidate: Candidate = { ...change, queued: Date.now(), resolve: settled<LandReport>(resolve, report => report.status), reject: settled<unknown>(reject, () => 'failed') };
      signal.addEventListener('abort', leave, { once: true });
      queue.push(candidate);
      this.mirror(key);
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
        const run: TrainRun = train.current = { batch, since: Date.now(), step: 'stacking', checks: 0, stack: [], held: new Map(), stop: new AbortController(), probes: [] };
        this.mirror(key);
        try {
          if (!landing) throw new Error('Landing is not configured; the script calls configureLanding first');
          if (train.trouble) await this.mend(batch[0]!.ws, train.trouble).catch(() => undefined);
          const again = await this.round(landing, batch, train.trouble, run);
          train.current = undefined;
          train.queue.unshift(...again);
          train.trouble = undefined; train.halted = undefined;
          this.logTrain(run, 'done');
        } catch (error) {
          train.current = undefined;
          // A train that failed for a reason of its own runs again: its submissions did nothing wrong, and handing
          // them back would send every member through its rebase, its precheck and the queue once more.
          const left = batch.filter(candidate => !candidate.settled);
          if (run.stop.signal.aborted && !this.closed) {
            // A submission the train had stacked was withdrawn. The others go on at once, on a stack without it.
            train.queue.unshift(...left);
            this.logTrain(run, 'restacked');
            return;
          }
          if (error instanceof LandingHalted && !this.closed) {
            // Nothing is wrong with the submissions: they keep their place and board again once the branch is settled.
            // The main agent hears of the halt once, through whichever of them can still pass it on.
            train.queue.unshift(...left);
            if (train.halted !== error.notice) { train.halted = error.notice; left.find(candidate => candidate.noticed)?.noticed!(error.notice, true); }
            wait = this.timing.haltPollMs;
            this.logTrain(run, 'halted', error);
            return;
          }
          wait = this.closed ? undefined : this.retryDelay(train, error);
          if (wait !== undefined) { train.queue.unshift(...left); this.logTrain(run, 'retrying', error); return; }
          let failure = error;
          if (train.trouble && error instanceof GitFailure) {
            this.say(key, this.troubled(batch[0]!.ws, train.trouble, false));
            failure = new Error(`The landing train failed ${train.trouble.failures + 1} times in a row for a reason of its own and gave this batch up: ${error.message.trim()}\n`
              + 'Nothing is wrong with your commits and they are untouched. Do not run Git in the train\'s worktree and do not remove its lock files; submit again later.');
          }
          train.trouble = undefined;
          for (const candidate of left) candidate.reject(failure);
          this.logTrain(run, 'failed', error);
        }
      });
      this.mirror(key);
      // The worktree is free while the train waits, so the main agent can settle the branch or change the checks.
      if (wait) { await this.pause(wait, wake => { train.wake = wake; }); train.wake = undefined; }
    }
    for (const candidate of train.queue.splice(0)) candidate.reject(this.stopping.signal.reason);
    train.running = false;
    if (this.trains.get(key) === train) this.trains.delete(key);
    this.mirror(key);
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
  /** Puts the train's worktree of `ws`'s repository at `commit`, with nothing in it that Git does not ignore. */
  private async park(ws: WorkspaceBinding, path: string, commit: string, signal: AbortSignal): Promise<void> {
    // wsfs moves its workspace without writing a file. Git resets any other, and one the daemon would not move.
    const moved = ws.isolation === 'wsfs' && await this.mounts.move(this.trainOwner(ws), commit, signal)
      // A move left unfinished is the train's own trouble, like a Git command that failed: it runs again.
      .catch((error: Error) => { throw new GitFailure(error.message); });
    if (!moved) await this.git(path, ['reset', '--hard', '--quiet', commit], signal);
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
    await this.park(ws, path, current, signal);
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
   * A submission whose commits are all on the branch already has landed, and one whose commits the submissions below
   * it hold lands when they do: neither adds a commit, so neither is a place the search looks at.
   * A submission that was withdrawn meanwhile is left out; when its commits were already in the stack the train stops
   * (`Restacked`) and runs again without them. Returns the submissions to queue again.
   */
  private async round(landing: WorkspaceLanding, batch: Candidate[], trouble: TrainTrouble | undefined, run: TrainRun): Promise<Candidate[]> {
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
    const at = (commit: string) => this.park(ws, path, commit, signal);
    const identity = await this.identity(path, signal);
    const { stack, held } = run, heads = [start], again = new Set<Candidate>();
    run.base = expected; run.checked = workflowDigest(landing.commands);
    for (const candidate of batch) {
      // Withdrawn since the train took it from the queue.
      if (candidate.settled) continue;
      if (candidate.ctx.signal.aborted) { candidate.reject(candidate.ctx.signal.reason); continue; }
      const head = heads.at(-1)!;
      let stacked = await this.graft(path, head, candidate, identity, signal);
      if (!stacked) {
        // Not a plain line of commits: the worktree picks them one by one.
        await at(head);
        const detail = await this.stack(path, head, candidate, identity, signal);
        stacked = detail === undefined ? { head: await this.revision(path, undefined, signal) } : { conflict: detail };
      }
      // Withdrawn while its commits were being stacked: they stay out of what is checked.
      if (candidate.settled) continue;
      if (!('head' in stacked)) {
        if (head === start) candidate.resolve(told({ status: 'conflict', targetRef, targetCommit: start, detail: stacked.conflict }));
        else again.add(candidate);
      }
      // A branch that does not exist yet is made by the train that lands on it, whatever it carries.
      else if (stacked.head !== head || expected === null && !stack.length) { stack.push(candidate); heads.push(stacked.head); }
      // Everything it brings is below it already, so the stack is the same commit with it and without: the checks say
      // nothing of it, and it takes no place in the search. On the branch itself it has landed.
      else if (stack.length) held.set(candidate, stack.length);
      else candidate.resolve(told({ status: 'landed', targetRef, headCommit: start, commits: 0 }));
    }
    this.mirror(key);
    const withdrawn = () => { if (run.stop.signal.aborted) throw new Restacked('A submission was withdrawn from the train'); };
    /** Runs the checks on `commit`, the stack after `count` submissions, and writes the run down for the ledger. */
    const check = async (commit: string, count: number): Promise<CheckFailure | undefined> => {
      withdrawn();
      run.step = 'checking'; run.checks++; run.checking = { submissions: count, since: Date.now() };
      this.mirror(key);
      await at(commit);
      const began = Date.now(), watched = this.timed(landing, ws, run, count);
      const noted = (failed?: CheckFailure, stopped?: unknown) => {
        const broke = failed?.commands.find(result => result.code);
        run.probes.push({ submissions: count, headCommit: commit, ms: Date.now() - began, passed: !failed && !stopped, ...(watched() ? { slow: true as const } : {}),
          ...(broke ? { command: broke.argv.join(' ').slice(0, 200), code: broke.code } : {}),
          ...(failed?.reason ? { reason: failed.reason } : stopped ? { reason: (stopped instanceof Error ? stopped.message : String(stopped)).slice(0, 200) } : {}) });
        run.checking = undefined;
        this.mirror(key);
        return failed;
      };
      try {
        // A withdrawal stops the commands that run; what Git does around them is left to finish.
        const commands = tail(await this.run(path, landing.commands, AbortSignal.any([signal, run.stop.signal]), deadlineAt));
        if (commands.length !== landing.commands.length || commands.some(result => result.code)) return noted({ commands });
        if ((await this.status(path, signal)).count) return noted({ commands, reason: 'Checks left uncommitted or untracked files in the worktree' });
        if (await this.revision(path, undefined, signal) !== commit) return noted({ commands, reason: 'Checks changed the worktree HEAD' });
      } catch (error) { noted(undefined, error); throw error; }
      return noted();
    };
    // heads[n] is the stack after n submissions, each of which added to it. The branch head, heads[0], passed when it landed.
    let good = 0, bad = stack.length + 1, failure: CheckFailure | undefined;
    for (let probe = stack.length; bad - good > 1; probe = Math.floor((good + bad) / 2)) {
      const failed = await check(heads[probe]!, probe);
      if (failed) { bad = probe; failure = failed; } else good = probe;
    }
    // From here the branch moves, and no submission of the stack can be taken back (see `withdraw`).
    withdrawn();
    run.step = 'landing';
    this.mirror(key);
    const head = heads[good]!;
    if (good) {
      // The next run looks at the branch first: it vouches for what was added and stacks these submissions on it, or halts.
      if (await this.refHead(ws.repository, targetRef, signal) !== expected) throw new BranchMoved('Landing branch was moved from outside the landing queue; submit again');
      await this.takeBack(ws, targetRef, signal);
      const landed = stack.slice(0, good), from = landed.slice(0, 16).map(candidate => candidate.ws.id.slice(0, 8)).join(',');
      await this.advance(ws, targetRef, head, expected, `bridge-workflow: landed ${good} submission(s), ${landed.reduce((total, candidate) => total + candidate.commits, 0)} commit(s) from ${from}${good > 16 ? ',…' : ''}`, signal);
      run.head = head;
    }
    for (const candidate of stack.slice(0, good)) candidate.resolve(told({ status: 'landed', targetRef, headCommit: head, commits: candidate.commits }));
    if (failure) stack[bad - 1]!.resolve(told({ status: 'check_failed', targetRef, targetCommit: head, headCommit: heads[bad]!, ...failure }));
    for (const candidate of stack.slice(bad)) again.add(candidate);
    // What it stood on has landed, and with that all it brought; or it has not, and the next train stacks it anew.
    for (const [candidate, below] of held) {
      if (candidate.settled) continue;
      if (below <= good) candidate.resolve(told({ status: 'landed', targetRef, headCommit: head, commits: 0 }));
      else again.add(candidate);
    }
    // Said once a report carried it; a train that only requeues its submissions says it on the next.
    if (said) this.unsaid.delete(key);
    return batch.filter(candidate => again.has(candidate) && !candidate.settled);
  }
  /**
   * Takes the submission whose commits end at `headCommit` out of the landing queue and answers it `withdrawn`, with
   * `reason`. One that waits for a train leaves the queue. One on the train that runs is left out of it: when its
   * commits are already in the stack the check that runs is stopped, and the train runs again at once with the others
   * (stacking costs next to nothing, a check that goes on with commits known to be bad costs the queue its time).
   * Once the train has passed the checks and moves the branch, the commits land and nothing is taken back.
   */
  withdraw(workflowId: string, headCommit: string, reason: string): LandWithdrawal {
    const targetRef = this.closed ? undefined : this.landing(workflowId)?.targetRef;
    if (!targetRef) return 'absent';
    const same = (candidate: Candidate) => !candidate.settled && candidate.ws.workflowId === workflowId && candidate.head === headCommit;
    for (const train of this.trains.values()) {
      const run = train.current, riding = run?.batch.find(same), candidate = riding ?? train.queue.find(same);
      if (!candidate) continue;
      if (riding && run!.step === 'landing') return 'landing';
      if (!riding) train.queue.splice(train.queue.indexOf(candidate), 1);
      candidate.resolve({ status: 'withdrawn', targetRef, targetCommit: candidate.base, headCommit, reason });
      if (riding && run!.stack.includes(candidate)) run!.stop.abort(new Restacked('A submission was withdrawn from the train'));
      this.mirror(this.trainKey(candidate.ws));
      return 'withdrawn';
    }
    return 'absent';
  }
  /**
   * How long a run of the checks that passed usually takes in this repository: the median of the latest such runs
   * under the same commands, those of the train that runs included, once there are enough of them to say.
   */
  private usualCheckMs(ws: Pick<WorkspaceBinding, 'workflowId' | 'repository'>, commands: WorkspaceCommands, run?: TrainRun): number | undefined {
    const checked = workflowDigest(commands);
    let past: ReturnType<WorkflowWorkspaces['ledger']> = [];
    // The ledger is a record of the landing: a train does not stop because it cannot be read.
    try { past = this.ledger(ws.workflowId, TRAIN_USUAL_CHECKS, ws.repository); } catch { /* nothing to compare with */ }
    const passed = [...(run?.checked === checked ? [...run.probes].reverse() : []), ...past.flatMap(train => train.checked === checked ? [...train.checks].reverse() : [])]
      .filter(probe => probe.passed).slice(0, TRAIN_USUAL_CHECKS).map(probe => probe.ms).sort((a, b) => a - b);
    return passed.length < TRAIN_USUAL_CHECKS_MIN ? undefined : passed[Math.floor(passed.length / 2)];
  }
  /**
   * Watches a run of the checks on the stack after `count` submissions, and tells the main agent while it still runs
   * once it has taken far longer than the runs that passed usually do. A submission that slows the checks without
   * failing them is not turned back: it rides every train until something else is, and each run that includes it
   * holds up the whole queue. Returns what ends the watch and says whether the run was reported.
   */
  private timed(landing: WorkspaceLanding, ws: WorkspaceBinding, run: TrainRun, count: number): () => boolean {
    const usual = this.usualCheckMs(ws, landing.commands, run);
    if (usual === undefined) return () => false;
    const after = Math.max(usual * this.timing.slowCheckFactor, usual + this.timing.slowCheckExtraMs);
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      const span = (ms: number) => ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60_000)} 分钟`;
      const named = (candidate: Candidate) => `${candidate.label?.key ?? short(candidate.head)}${candidate.label?.member ? `（${candidate.label.member}）` : ''}`;
      // A run of this train that passed in the usual time held none of what makes this one slow. One that failed may
      // have stopped before it got to the slow part.
      const usualUpTo = Math.max(0, ...run.probes.filter(probe => probe.passed && !probe.slow && probe.submissions < count).map(probe => probe.submissions));
      const suspects = run.stack.slice(usualUpTo, count);
      const limit = Math.max(...landing.commands.map(command => command.timeoutMs));
      const notice = `落地列车（${ws.repository}）的一次检查已经跑了 ${span(after)}，近期通过的检查通常 ${span(usual)}。这次检查的是本班前 ${count} 笔提交叠在一起的结果`
        + (usualUpTo ? `；本班在前 ${usualUpTo} 笔上的检查通过且用时正常，拖慢它的在第 ${usualUpTo + 1}${count > usualUpTo + 1 ? `–${count}` : ''} 笔里` : '')
        + `：${suspects.slice(0, 8).map(named).join('、')}${suspects.length > 8 ? ` 等 ${suspects.length} 笔` : ''}。`
        + `让检查变慢而不失败的提交不会被退回，会跟着每一班重跑；检查命令到时限（${span(limit)}）才算超时，那时这一班的提交全部退回各自成员。`
        + '查明是哪一笔后用 withdraw_work({key,reason}) 把它撤出队列：列车停下这次检查，去掉它重新组批，该提交退回原成员。configure_landing({trains:N}) 列出最近各班每次检查的用时。';
      const hears = run.batch.find(candidate => !candidate.settled && candidate.noticed);
      if (hears) hears.noticed!(notice, false); else this.say(this.trainKey(ws), notice);
    }, after);
    timer.unref();
    return () => { clearTimeout(timer); return slow; };
  }
  /** The latest trains of a workflow's landing ledger, newest first; of one repository when it is named. */
  private ledger(workflow: string, limit: number, repository?: string): Array<LandingTrain & { checked?: string }> {
    const rows = (repository === undefined ? this.db.prepare('SELECT data FROM landing_trains WHERE workflow=? ORDER BY id DESC LIMIT ?').all(workflow, limit)
      : this.db.prepare('SELECT data FROM landing_trains WHERE workflow=? AND repository=? ORDER BY id DESC LIMIT ?').all(workflow, repository, limit)) as Array<{ data: string }>;
    return rows.map(row => JSON.parse(row.data) as LandingTrain & { checked?: string });
  }
  /**
   * Writes a train's queue as it stands to the store (see `LandingLive`), whenever it may have changed: a submission
   * joined or left, the train took a batch, a run of the checks began or ended. Like the ledger it is a record of the
   * landing and no part of it: failing to write it changes nothing.
   */
  private mirror(key: string): void {
    try {
      const train = this.trains.get(key), known = this.lives.get(key), run = train?.current;
      const any = (run?.batch[0] ?? train?.queue[0])?.ws;
      const workflow = any?.workflowId ?? known?.workflow, repository = any?.repository ?? known?.repository;
      if (!workflow || !repository) return;
      const rider = (candidate: Candidate): LandingRider => ({ ...candidate.label, workspace: candidate.ws.id, headCommit: candidate.head, commits: candidate.commits, since: candidate.queued });
      const live: Omit<LandingLive, 'at'> = { repository, waiting: (train?.queue ?? []).map(rider),
        ...(run ? { train: { since: run.since, step: run.step, ...(run.base === undefined ? {} : { base: run.base }),
          riders: run.batch.map(candidate => ({ ...rider(candidate), state: candidate.settled ? candidate.outcome ?? 'failed' : run.stack.includes(candidate) || run.held.has(candidate) ? 'stacked' : 'taken' })),
          checks: run.probes, ...(run.checking ? { checking: run.checking } : {}) } } : {}),
        ...(train?.trouble ? { retrying: { failures: train.trouble.failures, since: train.trouble.since, reason: train.trouble.reason } } : {}),
        ...(train?.halted ? { halted: train.halted.slice(0, 2000) } : {}) };
      const data = JSON.stringify(live);
      if (known?.data === data) return;
      this.lives.set(key, { workflow, repository, data });
      this.db.prepare('INSERT INTO landing_live (workflow, repository, at, data) VALUES (?,?,?,?) ON CONFLICT(workflow, repository) DO UPDATE SET at=excluded.at, data=excluded.data')
        .run(workflow, repository, Date.now(), data);
    } catch { /* see above */ }
  }
  /**
   * Writes a run of a train to the landing ledger: what it carried, each run of the checks, and what became of each
   * submission. A run that checked nothing and answered nobody (it waited for a halted branch, or failed at once and
   * runs again) is left out. The ledger is a record of the landing and no part of it: failing to write it changes nothing.
   */
  private logTrain(run: TrainRun, outcome: LandingTrain['outcome'], error?: unknown): void {
    if (!run.probes.length && !run.batch.some(candidate => candidate.settled)) return;
    try {
      const { ws } = run.batch[0]!;
      const train: LandingTrain & { checked?: string } = { repository: ws.repository, since: run.since, ms: Date.now() - run.since, base: run.base ?? null, ...(run.head ? { head: run.head } : {}),
        submissions: run.batch.map(candidate => ({ ...candidate.label, workspace: candidate.ws.id, headCommit: candidate.head, commits: candidate.commits, outcome: candidate.settled ? candidate.outcome ?? 'failed' : 'next' })),
        checks: run.probes, outcome, ...(error === undefined ? {} : { error: (error instanceof Error ? error.message : String(error)).slice(0, 600) }),
        ...(run.checked ? { checked: run.checked } : {}) };
      this.db.prepare('INSERT INTO landing_trains (workflow, repository, since, data) VALUES (?,?,?,?)').run(ws.workflowId, ws.repository, run.since, JSON.stringify(train));
      this.db.prepare('DELETE FROM landing_trains WHERE workflow=? AND id <= (SELECT id FROM landing_trains WHERE workflow=? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(ws.workflowId, ws.workflowId, TRAIN_LEDGER_KEPT);
    } catch { /* see above */ }
  }
  /**
   * Puts a submission's commits on top of `head` without a worktree. Each commit is merged into the stack in the object
   * database, the way a pick merges it (its parent is the merge base), and committed again with its author and message.
   * A pick in the worktree rewrites the index and looks at every file of the checkout for each commit, which on a
   * network file system takes longer than the merge by orders of magnitude, and it holds the index lock all the while.
   * Returns the new head, or what Git said of the conflict. Returns nothing for commits this does not stack (a merge, a
   * message in another encoding, a Git without `merge-tree --merge-base`): the worktree picks those.
   */
  private async graft(path: string, head: string, candidate: Pick<Candidate, 'base' | 'head'>, identity: string[], signal: AbortSignal): Promise<{ head: string } | { conflict: string } | undefined> {
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
  /**
   * The train's own worktree, one for each workflow and repository; it keeps the checks' build outputs between trains.
   * The train of a wsfs member is a wsfs workspace beside the members': a plain worktree is a checkout of every file,
   * and each move of it has Git look at every one of them. A workflow whose members were made in both ways has a
   * train of each kind, and they take turns like everything else that runs for the repository.
   */
  private trainPath(ws: Pick<WorkspaceBinding, 'workflowId' | 'commonDir' | 'isolation'>): string {
    return ws.isolation === 'wsfs' ? this.mounts.path(this.trainOwner(ws)) : join(resolve(this.directory), ws.workflowId, `train-${workflowDigest(ws.commonDir).slice(0, 16)}`);
  }
  /** The train as wsfs knows it. Its name is also that of its worktree record, which the repository shares with other workflows. */
  private trainOwner(ws: Pick<WorkspaceBinding, 'workflowId' | 'commonDir'>): WsfsOwner {
    return { workflowId: ws.workflowId, id: `train-${ws.workflowId}`, commonDir: ws.commonDir };
  }
  private async trainWorktree(ws: WorkspaceBinding, signal: AbortSignal): Promise<string> {
    const path = this.trainPath(ws);
    // Asked of the daemon, which is started again if it died: its mount would only say that nothing is there.
    const made = ws.isolation === 'wsfs' ? await this.mounts.has(this.trainOwner(ws)) : await access(join(path, '.git')).then(() => true, () => false);
    if (made) await this.git(path, ['cherry-pick', '--abort'], signal, true);
    else if (ws.isolation === 'wsfs') await this.mounts.create(this.trainOwner(ws), ws.baseCommit, signal);
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await this.worktree(ws, ['add', '--detach', '--lock', '--reason', `bridge-workflow:train:${ws.workflowId}`, path, ws.baseCommit], signal);
    }
    return path;
  }
  /** Removes the train's worktree, of either kind, once the last member worktree of its repository is gone. */
  private async retireTrain(ws: WorkspaceBinding, signal: AbortSignal): Promise<void> {
    const left = this.db.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE workflow=? AND kind='workspace' AND json_extract(data,'$.kind')='task' AND json_extract(data,'$.status')!='removed' AND json_extract(data,'$.commonDir')=?").get(ws.workflowId, ws.commonDir) as { n: number };
    if (left.n || this.trains.has(`${ws.workflowId}:${ws.commonDir}`)) return;
    const path = this.trainPath({ ...ws, isolation: undefined });
    if (await access(path).then(() => true, () => false)) {
      await this.worktree(ws, ['unlock', path], signal, true);
      await this.worktree(ws, ['remove', '--force', path], signal, true);
    }
    // With it goes the daemon, which serves no workspace of the workflow any more.
    if (await this.mounts.used(ws)) await this.mounts.remove(this.trainOwner(ws), signal).catch(() => undefined);
  }

  /**
   * The main agent's view of the landing and its changes to it while the workflow runs; without options it only
   * reports. `checks`, `precheck` (empty for none) and `batch` replace the script's settings, `protect` adds rules to
   * the script's (empty for none added), and `reset` drops every earlier change first. New commands are first run on
   * the landing branch as it is: on a branch that fails them every submission would be blamed for it, so the change
   * is refused and the branch has to be repaired under the current checks first. `branch` settles a branch the queue
   * does not vouch for: "restore" puts it back where the queue left it and keeps the outside commits under a ref,
   * "adopt" has the queue vouch for it as it is. `trains` changes nothing: it adds that many of the latest trains of
   * the landing ledger to the answer (see `LandingTrain`).
   */
  configure(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<LandingChange> {
    if (this.closed) return Promise.reject(new Error('Workspace service is closed'));
    const pending = this.configureInner(ctx, input); this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  private async configureInner(ctx: WorkspaceContext, input: Record<string, unknown>): Promise<LandingChange> {
    const workflow = ctx.state.workflowId, { signal } = this.stopping;
    if (Object.keys(input).some(key => !['checks', 'precheck', 'protect', 'batch', 'reset', 'branch', 'trains'].includes(key))) throw new Error('Unsupported configure_landing option');
    const trains = input.trains === undefined ? undefined : boundedInteger(input.trains, 16, 1, 100);
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
      landing: await this.view(base, refused ? stored : next, repos, signal),
      ...(trains === undefined ? {} : { trains: this.ledger(workflow, trains).map(({ checked: _checked, ...train }) => train) }) };
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
    await this.park(ws, path, head, signal);
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
    // Whoever moved the branch may still be on it, and stays on the commits it made, which `kept` names.
    await this.takeBack(ws, targetRef, signal);
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
      const usual = this.usualCheckMs(ws, landing.commands, train?.current), seconds = (ms: number) => Math.round(ms / 1000);
      const recent = this.ledger(ws.workflowId, 5, ws.repository).map(past => {
        const back = past.submissions.filter(entry => !['landed', 'next'].includes(entry.outcome));
        return { since: past.since, seconds: seconds(past.ms), submissions: past.submissions.length, landed: past.submissions.filter(entry => entry.outcome === 'landed').length, outcome: past.outcome,
          checks: past.checks.map(probe => ({ submissions: probe.submissions, seconds: seconds(probe.ms), passed: probe.passed, ...(probe.slow ? { slow: true as const } : {}) })),
          ...(back.length ? { turnedBack: back.slice(0, 8).map(entry => ({ ...(entry.key ? { key: entry.key } : {}), ...(entry.member ? { member: entry.member } : {}), status: entry.outcome })) } : {}) };
      });
      branches.push({ repository: ws.repository, head, ...(known ? { landed: known.head } : {}), waiting: train?.queue.length ?? 0,
        ...(known?.halt && known.halt.head === head ? { halted: known.halt.reason } : {}),
        ...(train?.current ? { train: { submissions: train.current.batch.length, step: train.current.step, checks: train.current.checks, since: train.current.since } } : {}),
        ...(train?.trouble ? { retrying: { failures: train.trouble.failures, since: train.trouble.since, reason: train.trouble.reason } } : {}),
        ...(usual === undefined ? {} : { usualCheckSeconds: seconds(usual) }), ...(recent.length ? { recent } : {}) });
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
    this.mounts.close();
    await Promise.allSettled([...this.pending]); this.db.close();
  }
}
