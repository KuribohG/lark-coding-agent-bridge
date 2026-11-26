import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { access, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowDigest } from './digest';
import type { WorkflowProcesses } from './ports';

/** The workspace a request is about: its workflow, its ID, and the Git directory of the repository it is made from. */
export type WsfsOwner = { workflowId: string; id: string; commonDir: string };
type Mounted = Pick<WsfsOwner, 'workflowId' | 'commonDir'>;
/** Where one mount is and where it keeps what its workspaces changed; the daemon that serves it listens at `control`. */
interface Place { mount: string; state: string; control: string; log: string; record: string; of: Mounted }
type Answer = { ok?: boolean; error?: string; unfinished?: boolean; workspaces?: Array<{ name: string; base: string }> } & Record<string, unknown>;

/** The daemon answers a creation in well under a second; giving up thousands of files on a network filesystem takes longer. */
const REQUEST_TIMEOUT_MS = 600_000;
/** A daemon that is starting opens every workspace it finds before it listens. */
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 30_000;
/** How often the daemons are looked at: one that died leaves the members in its workspaces with every file unreadable. */
const WATCH_MS = 15_000;
const exists = (path: string) => access(path).then(() => true, () => false);
const pause = (ms: number) => new Promise<void>(done => { setTimeout(done, ms); });

/** The `wsfs` binary: the one named by WORKFLOW_WSFS_COMMAND, or the one built into `bin/` beside this program. */
function command(): string {
  const named = process.env.WORKFLOW_WSFS_COMMAND;
  if (named) return named;
  // `bin/` of the installation: beside `dist/` for the bundle this is built into, and at the root of the repository
  // for the source file.
  const built = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../../../bin/wsfs' : '../bin/wsfs', import.meta.url));
  if (!existsSync(built)) throw new Error(`the wsfs binary is not at ${built} (it is built with the bridge where cargo is found): build packages/workspace-fs and name the binary with WORKFLOW_WSFS_COMMAND`);
  return built;
}

/** Sends one request to the daemon at `control` and gives its answer; fails when nothing listens there. */
function request(control: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Answer> {
  return new Promise((done, fail) => {
    const socket = createConnection(control);
    let text = '', settled = false;
    const settle = (error?: Error, answer?: Answer) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
      if (error) fail(error); else done(answer!);
    };
    const abort = () => settle(new Error('Workspace request aborted'));
    const timer = setTimeout(() => settle(new Error(`wsfs did not answer ${String(body.op)} in ${timeoutMs / 1000} s`)), timeoutMs);
    timer.unref(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', (chunk: string) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0) return;
      try { settle(undefined, JSON.parse(text.slice(0, end)) as Answer); } catch { settle(new Error('wsfs answered what is not JSON')); }
    });
    socket.once('error', error => settle(error));
    socket.once('close', () => settle(new Error('wsfs closed the connection without an answer')));
  });
}
/**
 * Whether a daemon listens at `control`. Only connecting is asked of it: a daemon that is busy moving a workspace
 * answers late, and is not one to start another beside.
 */
function listening(control: string): Promise<boolean> {
  return new Promise(done => {
    const socket = createConnection(control);
    const settle = (found: boolean) => { clearTimeout(timer); socket.destroy(); done(found); };
    const timer = setTimeout(() => settle(false), 10_000);
    timer.unref();
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}
/** What the daemon is given of this process's environment: it reads Git's configuration and runs fusermount3, and needs no secret. */
const daemonEnv = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME']
  .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])), RUST_BACKTRACE: '1' });

/**
 * Workspaces served by wsfs (packages/workspace-fs): each is a directory of a FUSE mount that shows a commit read
 * from the repository's object database, under the files the workspace changed. Making one writes an index and no
 * checkout file, and moving one to another commit writes none either.
 *
 * One daemon serves the workspaces of one workflow in one repository. It is a process of its own that outlives this
 * service, so members keep working across a restart; it is started when a workspace is first asked for and whenever
 * it is found gone, and stopped when its last workspace is removed. A daemon that died loses nothing: what the
 * workspaces changed is in plain files under its state directory, which the next one reads.
 */
export class WsfsMounts {
  private readonly places = new Map<string, Promise<Place>>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly stopping = new Map<string, Promise<void>>();
  /** The requests under way at each mount; a daemon is stopped only when it has no workspace and nobody is asking. */
  private readonly users = new Map<string, number>();
  private usable?: Promise<void>;
  private watch?: NodeJS.Timeout;
  /** The workflows that still run, when the host says; the daemons of the others are left as they are found. */
  private live?: () => ReadonlySet<string>;
  private closed = false;

  constructor(private readonly directory: string, private readonly processes: WorkflowProcesses) {}

  private key(ws: Pick<WsfsOwner, 'commonDir'>): string { return workflowDigest(ws.commonDir).slice(0, 16); }
  /** The mount point of a workflow's workspaces in one repository. */
  private mount(ws: Mounted, directory = resolve(this.directory)): string {
    return join(directory, ws.workflowId, `wsfs-${this.key(ws)}`);
  }
  /** The directory of a workspace below `directory`: this service derives it, and never reads it back. */
  path(ws: WsfsOwner, directory?: string): string { return join(this.mount(ws, directory), ws.id); }
  /** Where a mount keeps its state unless it recorded another place when it was first served. */
  private state(ws: Mounted): string {
    const root = process.env.WORKFLOW_WSFS_STATE;
    return root ? join(resolve(root), ws.workflowId, `wsfs-${this.key(ws)}`) : `${this.mount(ws)}.state`;
  }

  /**
   * Whether wsfs workspaces can be made here; told before anything is recorded, so a refused key stays free for
   * another isolation.
   */
  available(): Promise<void> {
    return this.usable ??= (async () => {
      if (process.platform !== 'linux') throw new Error('they need Linux');
      const binary = command();
      if (binary.includes('/') && !await exists(binary)) throw new Error(`${binary} does not exist`);
      if (!await exists('/dev/fuse')) throw new Error('/dev/fuse is missing');
      const helpers = (process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(dir => [join(dir, 'fusermount3'), join(dir, 'fusermount')]);
      if (!(await Promise.all(helpers.map(exists))).some(Boolean)) throw new Error('fusermount3 (package fuse3) is not on PATH');
    })().catch(error => {
      this.usable = undefined;
      throw new Error(`wsfs workspaces are unavailable here: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * The state directory and the socket of a mount are settled when it is first served and recorded beside it: the
   * settings may change while its workspaces exist, and a daemon started over them again must find their files.
   */
  private place(ws: Mounted): Promise<Place> {
    const mount = this.mount(ws);
    const known = this.places.get(mount);
    if (known) return known;
    const found = (async (): Promise<Place> => {
      const record = `${mount}.json`;
      let kept: { state?: unknown; control?: unknown } = {};
      try { kept = JSON.parse(await readFile(record, 'utf8')) as typeof kept; } catch { /* first use */ }
      let { state, control } = kept;
      if (typeof state !== 'string' || typeof control !== 'string') {
        state = this.state(ws);
        // A Unix socket needs a filesystem that has them and a path of about a hundred bytes: the local temporary
        // directory, in a directory of this user's own.
        control = join(tmpdir(), `bridge-wsfs-${userInfo().uid}`, `${createHash('sha256').update(mount).digest('hex').slice(0, 32)}.sock`);
        await mkdir(dirname(record), { recursive: true, mode: 0o700 });
        await writeFile(`${record}.${process.pid}`, JSON.stringify({ state, control }) + '\n', { mode: 0o600 });
        await rename(`${record}.${process.pid}`, record);
      }
      return { mount, state: state as string, control: control as string, log: `${mount}.log`, record, of: { workflowId: ws.workflowId, commonDir: ws.commonDir } };
    })().catch(error => { this.places.delete(mount); throw error; });
    this.places.set(mount, found);
    if (!this.closed) (this.watch ??= setInterval(() => { void this.look(); }, WATCH_MS)).unref();
    return found;
  }
  /**
   * Starts again the daemon of every mount this service has used that no longer answers. A member that is in the
   * middle of a turn asks nothing of this service, and would otherwise find no file of its workspace until somebody did.
   */
  private async look(): Promise<void> {
    const live = this.live?.();
    for (const [mount, found] of [...this.places]) {
      const place = await found.catch(() => undefined);
      if (!place || this.closed || this.users.has(mount) || this.stopping.has(mount) || live && !live.has(place.of.workflowId)) continue;
      // The record goes with the mount: another service may have removed its last workspace.
      if (!await exists(place.record)) { if (this.places.get(mount) === found) this.places.delete(mount); continue; }
      await this.served(place.of, async () => undefined).catch(() => undefined);
    }
  }
  /** Has the daemon of a mount that was served before looked after from now on, as after a restart of this service. */
  know(ws: Mounted): void {
    void exists(`${this.mount(ws)}.json`).then(served => served && !this.closed ? this.place(ws) : undefined).catch(() => undefined);
  }
  /** Names the workflows that still run; only their daemons are started again when they are found gone. */
  tend(live: () => ReadonlySet<string>): void { this.live = live; }
  close(): void { this.closed = true; clearInterval(this.watch); }

  /** Runs `work` with the daemon of the workspace's mount running, starting it when it is not. */
  private async served<T>(ws: Mounted, work: (place: Place) => Promise<T>): Promise<T> {
    let place = await this.place(ws);
    this.users.set(place.mount, (this.users.get(place.mount) ?? 0) + 1);
    try {
      // A daemon that is being stopped takes the record of its mount with it: the place is settled anew.
      const stopping = this.stopping.get(place.mount);
      if (stopping) { await stopping; place = await this.place(ws); }
      if (!await listening(place.control)) {
        let start = this.starting.get(place.mount);
        if (!start) {
          start = this.start(place, ws.commonDir).finally(() => { if (this.starting.get(place.mount) === start) this.starting.delete(place.mount); });
          this.starting.set(place.mount, start);
        }
        await start;
      }
      return await work(place);
    } finally {
      const left = this.users.get(place.mount)! - 1;
      if (left) this.users.set(place.mount, left); else this.users.delete(place.mount);
    }
  }
  private async start(place: Place, commonDir: string): Promise<void> {
    await this.available();
    for (const dir of [dirname(place.mount), dirname(place.state), dirname(place.control)]) await mkdir(dir, { recursive: true, mode: 0o700 });
    // Whoever can put a socket there is asked to make and remove workspaces: the directory is this user's alone.
    const holds = await stat(dirname(place.control));
    if (holds.uid !== userInfo().uid || holds.mode & 0o022) throw new Error(`${dirname(place.control)} is not a directory only this user can write to`);
    // What a daemon that died left mounted there answers nothing, not even that it is a directory; the next one replaces it.
    await mkdir(place.mount, { mode: 0o700 }).catch(() => undefined);
    const log = openSync(place.log, 'a', 0o600);
    let ended: string | undefined;
    try {
      // Detached, with nothing of this process's to hold on to: the daemon serves members that outlive this service.
      const child = this.processes.spawn(command(), ['mount', '--repo', commonDir, '--state', place.state, '--control', place.control, place.mount],
        { cwd: '/', env: daemonEnv(), detached: true, shell: false, windowsHide: true, stdio: ['ignore', log, log] });
      child.once('error', error => { ended ??= error.message; });
      child.once('exit', (code, killedBy) => { ended ??= killedBy ? `killed by ${killedBy}` : `exit code ${code}`; });
      child.unref();
    } finally { closeSync(log); }
    // The daemon listens once it has mounted and opened the workspaces it found.
    for (const until = Date.now() + START_TIMEOUT_MS; Date.now() < until; await pause(50)) {
      if (await listening(place.control)) return;
      if (ended !== undefined) break;
    }
    const said = (await readFile(place.log, 'utf8').catch(() => '')).trim().split('\n').slice(-6).join('\n').slice(-1200);
    throw new Error(`wsfs could not serve ${place.mount} (${ended ?? 'it did not start listening'}): ${said || 'it logged nothing'}. It needs fusermount3 (package fuse3) on PATH.`);
  }
  private async call(place: Place, body: Record<string, unknown>, signal?: AbortSignal): Promise<Answer> {
    const answer = await request(place.control, body, signal);
    if (answer.ok !== true) throw new Error(`wsfs ${String(body.op)} failed: ${String(answer.error ?? 'no reason given').slice(0, 1200)}`);
    return answer;
  }
  private async listed(place: Place, ws: WsfsOwner): Promise<{ name: string; base: string } | undefined> {
    return (await this.call(place, { op: 'list' })).workspaces?.find(entry => entry.name === ws.id);
  }

  /** Has the daemon of a workspace's mount running; whoever is bound to the workspace finds it served. */
  async serve(ws: WsfsOwner): Promise<void> {
    await this.served(ws, async place => {
      if (!await this.listed(place, ws)) throw new Error(`wsfs has no workspace ${ws.id}; its files were under ${place.state}`);
    });
  }
  /** Whether the workspace exists, asked of a daemon that is running. */
  has(ws: WsfsOwner): Promise<boolean> { return this.served(ws, async place => Boolean(await this.listed(place, ws))); }
  /** Whether the workflow has, or had and did not remove, wsfs workspaces of the repository. */
  used(ws: Mounted): Promise<boolean> { return exists(`${this.mount(ws)}.json`); }
  /**
   * Makes the workspace at `commit`, a linked worktree of the repository with HEAD detached there. One that exists is
   * made again: a workspace is created only while nobody has worked in it.
   */
  async create(ws: WsfsOwner, commit: string, signal: AbortSignal): Promise<void> {
    await this.served(ws, async place => {
      if (await this.listed(place, ws)) await this.call(place, { op: 'remove', name: ws.id }, signal);
      await this.call(place, { op: 'create', name: ws.id, base: commit }, signal);
    });
  }
  /**
   * Moves the workspace to `commit` as `git reset --hard` does, HEAD included: tracked files become the commit's and
   * untracked ones stay. No file is written, and the files the workspace held that the commit has are given up.
   * False when the daemon refused and changed nothing, which leaves the move to Git in the workspace. A move that
   * was begun and could not be finished fails: the workspace is between two commits until the daemon finishes it.
   */
  async move(ws: WsfsOwner, commit: string, signal: AbortSignal): Promise<boolean> {
    return this.served(ws, async place => {
      const answer = await request(place.control, { op: 'set_base', name: ws.id, base: commit, mode: 'reset', head: true }, signal);
      if (answer.unfinished) throw new Error(`wsfs could not finish moving the workspace to ${commit}: ${String(answer.error).slice(0, 1200)}. The workspace is between two commits; submit again later, or have the workspace cleaned up`);
      return answer.ok === true;
    });
  }
  /** Removes the workspace with everything in it and its worktree record, and stops a daemon that serves no other. */
  async remove(ws: WsfsOwner, signal: AbortSignal): Promise<void> {
    const place = await this.served(ws, async place => {
      if (await this.listed(place, ws)) await this.call(place, { op: 'remove', name: ws.id }, signal);
      return place;
    });
    await this.retire(place);
  }
  /** Stops the daemon of a mount that has no workspace left and nobody asking. */
  private async retire(place: Place): Promise<void> {
    if (this.users.has(place.mount) || this.stopping.has(place.mount)) return;
    // Marked before anything is awaited: a request that arrives from here on waits for the answer.
    const stop = (async () => {
      const left = await request(place.control, { op: 'list' }, undefined, 10_000).then(answer => answer.workspaces?.length ?? 0, () => undefined);
      if (left !== 0) return;
      await request(place.control, { op: 'shutdown' }, undefined, STOP_TIMEOUT_MS).catch(() => undefined);
      for (const until = Date.now() + STOP_TIMEOUT_MS; Date.now() < until && await listening(place.control); await pause(50));
      // A daemon that would not stop keeps what is its own; it serves the mount's next workspace.
      if (await listening(place.control)) return;
      this.places.delete(place.mount);
      // What is left holds no workspace. Only directories this service derives are deleted, never one read back.
      await rmdir(place.mount).catch(() => undefined);
      if (place.state === this.state(place.of)) await rm(place.state, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      for (const file of [place.record, place.log]) await rm(file, { force: true }).catch(() => undefined);
    })().finally(() => { if (this.stopping.get(place.mount) === stop) this.stopping.delete(place.mount); });
    this.stopping.set(place.mount, stop);
    await stop;
  }
}
