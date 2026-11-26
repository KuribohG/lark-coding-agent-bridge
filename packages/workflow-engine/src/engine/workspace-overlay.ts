import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, readdir, realpath, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { BASE_TOKEN, FSMONITOR_HOOK } from './workspace-overlay-hook';
import { records, workspaceCommand, type CommandOutput, type CommandResult } from './workspace-process';
import type { WorkflowProcesses } from './ports';

/** Git as the workspace service runs it: no hooks of the user's, no prompts. Options (`-c`) lead the arguments. */
export type OverlayGit = (cwd: string, args: string[], signal: AbortSignal, allowFailure?: boolean, output?: CommandOutput) => Promise<CommandResult>;
/** The workspace an overlay belongs to, and the repository and commit its base tree is checked out from. */
export type OverlayOwner = { workflowId: string; id: string; path: string; commonDir: string; baseCommit: string };
/** Where an overlay workspace keeps what is its own; none of it is under the mount. */
export interface OverlayPlace { home: string; upper: string; work: string; git: string }

/** Git processes that write the files of a base tree at once. */
const BASE_CHECKOUT_WORKERS = 32;
/** The paths one of them is given on its command line; a command line holds twenty times as much. */
const BASE_CHECKOUT_PATHS = 1000, BASE_CHECKOUT_BYTES = 100_000;
/** Mounting and unmounting touch no checkout files. */
const MOUNT_TIMEOUT_MS = 60_000;
/** `rm` processes that delete a tree nobody reads any more, at once; a large one takes them minutes. */
const REMOVAL_SLOTS = 8, REMOVAL_TIMEOUT_MS = 3_600_000;
const exists = (path: string) => access(path).then(() => true, () => false);

function decodeVarint(buffer: Buffer, at: number): [value: number, next: number] {
  let byte = buffer[at++]!, value = byte & 127;
  while (byte & 128) { byte = buffer[at++]!; value = (value + 1) * 128 + (byte & 127); }
  return [value, at];
}
function encodeVarint(value: number): Buffer {
  const out = [value & 127];
  for (value = Math.floor(value / 128); value; value = Math.floor(value / 128)) out.unshift(128 | (--value & 127));
  return Buffer.from(out);
}

type IndexExtension = [signature: string, data: Buffer];
/** The entries of an index (version 2 or 3, SHA-1) and the extensions after them; nothing for any other file. */
function readIndex(index: Buffer): { entries: Buffer; extensions: IndexExtension[] } | undefined {
  const body = index.subarray(0, Math.max(0, index.length - 20));
  if (index.length < 32 || index.toString('latin1', 0, 4) !== 'DIRC' || ![2, 3].includes(index.readUInt32BE(4))
    || !createHash('sha1').update(body).digest().equals(index.subarray(index.length - 20))) return undefined;
  // Entries: a fixed header, the path and its NUL, padded to a multiple of eight bytes.
  let at = 12;
  for (let left = index.readUInt32BE(8); left; left--) {
    if (at + 62 > body.length) return undefined;
    const flags = body.readUInt16BE(at + 60), name = at + 62 + (flags & 0x4000 ? 2 : 0);
    const end = (flags & 0xfff) < 0xfff ? name + (flags & 0xfff) : body.indexOf(0, name);
    if (end < 0) return undefined;
    at += (end - at + 8) & ~7;
  }
  const entries = body.subarray(0, at), extensions: IndexExtension[] = [];
  while (at < body.length) {
    if (at + 8 > body.length || at + 8 + body.readUInt32BE(at + 4) > body.length) return undefined;
    extensions.push([body.toString('latin1', at, at + 4), body.subarray(at + 8, at + 8 + body.readUInt32BE(at + 4))]);
    at += 8 + extensions.at(-1)![1].length;
  }
  return { entries, extensions };
}
function writeIndex(entries: Buffer, extensions: IndexExtension[]): Buffer {
  const parts = [entries], headers = createHash('sha1');
  for (const [signature, given] of extensions) {
    const header = Buffer.alloc(8); header.write(signature, 'latin1'); header.writeUInt32BE(given.length, 4);
    // The end-of-entries extension closes the list with a hash of the headers before it.
    const closing = signature === 'EOIE' && given.length === 24;
    if (!closing) headers.update(header);
    parts.push(header, closing ? Buffer.concat([given.subarray(0, 4), headers.copy().digest()]) : given);
  }
  const out = Buffer.concat(parts);
  return Buffer.concat([out, createHash('sha1').update(out).digest()]);
}

/**
 * Retargets the untracked cache of a template index at another worktree. Git stores the worktree's location in that
 * extension and drops the cache when it differs, and the first `git status` of every workspace would then read every
 * directory of the checkout. An index this does not understand is returned as it is: Git then builds the cache anew.
 */
export function relocateIndex(index: Buffer, worktree: string): Buffer {
  const read = readIndex(index), cache = read?.extensions.find(([signature]) => signature === 'UNTR');
  if (!read || !cache) return index;
  const [length, start] = decodeVarint(cache[1], 0);
  const system = /, system ([^\0]*)\0?$/.exec(cache[1].toString('latin1', start, start + length));
  if (!system) return index;
  const ident = Buffer.concat([Buffer.from(`Location ${worktree}, system `), Buffer.from(system[1]!, 'latin1'), Buffer.alloc(1)]);
  cache[1] = Buffer.concat([encodeVarint(ident.length), ident, cache[1].subarray(start + length)]);
  return writeIndex(read.entries, read.extensions);
}

/**
 * Records in an index that no file differs from it: the fsmonitor extension under `token`, with no entry marked as
 * one to look at. Git then takes every entry at its word. Left to find it out, Git reads every file of the checkout,
 * and still marks none: an entry is marked only when a later look finds it as the index already had it. Gives nothing
 * for an index this does not understand.
 */
export function unchangedIndex(index: Buffer, token: string): Buffer | undefined {
  const read = readIndex(index);
  if (!read) return undefined;
  // Version 2 of the extension: the token, then the length and the bits (EWAH) of the entries to look at. The empty
  // set is no bits in one word, which is the first run.
  const none = Buffer.alloc(20); none.writeUInt32BE(1, 4);
  const head = Buffer.alloc(4), length = Buffer.alloc(4); head.writeUInt32BE(2); length.writeUInt32BE(none.length);
  const extensions = read.extensions.filter(([signature]) => signature !== 'FSMN');
  const end = extensions.findIndex(([signature]) => signature === 'EOIE');
  extensions.splice(end < 0 ? extensions.length : end, 0, ['FSMN', Buffer.concat([head, Buffer.from(token + '\0', 'latin1'), length, none])]);
  return writeIndex(read.entries, extensions);
}

/** Whether a FUSE filesystem is mounted at `path`, and whether the process that serves it is still there. */
async function mountState(path: string): Promise<'none' | 'live' | 'dead'> {
  const info = await readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
  // The kernel lists the mount point with its symlinks resolved; the point itself cannot be resolved once it is dead.
  const real = join(await realpath(dirname(path)).catch(() => dirname(path)), basename(path));
  const listed = real.replace(/[\\ \t\n]/g, char => '\\' + char.charCodeAt(0).toString(8).padStart(3, '0'));
  if (!info.split('\n').some(line => line.split(' ')[4] === listed)) return 'none';
  // statfs always asks the serving process. A stat would be answered from the kernel's cache of a mount that is dead.
  return statfs(path).then(() => 'live' as const, () => 'dead' as const);
}

/**
 * Overlay workspaces: each is a FUSE mount that shows one read-only checkout of the baseline, shared by every
 * workspace made from that commit, under a directory of the workspace's own that takes whatever it changes. Making
 * one writes no checkout files, and what it holds on disk is what its member changed.
 *
 * The mount is served by a process of its own (fuse-overlayfs) that outlives this service. When that process is gone
 * the directory answers ENOTCONN until it is mounted again; nothing is lost, since the changes are in plain files.
 */
export class WorkspaceOverlays {
  private readonly bases = new Map<string, Promise<{ tree: string; index: string }>>();
  private readonly mounting = new Map<string, Promise<void>>();
  private probed?: Promise<void>;
  private hooked?: Promise<string>;

  constructor(private readonly store: string, private readonly processes: WorkflowProcesses, private readonly git: OverlayGit,
    private readonly slot: (signal: AbortSignal) => Promise<() => void>) {}

  place(ws: Pick<OverlayOwner, 'workflowId' | 'id'>): OverlayPlace {
    const home = join(this.store, ws.workflowId, ws.id);
    return { home, upper: join(home, 'upper'), work: join(home, 'work'), git: join(home, 'git') };
  }

  /** The value of core.fsmonitor in an overlay workspace: the hook, written out once for all of them. */
  hook(): Promise<string> {
    return this.hooked ??= (async () => {
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
      const script = join(this.store, 'fsmonitor.cjs'), path = join(this.store, 'fsmonitor');
      await mkdir(this.store, { recursive: true, mode: 0o700 });
      for (const [file, text] of [[script, FSMONITOR_HOOK], [path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`]] as const) {
        // Written beside and renamed, so a Git that is starting the hook never reads half of it.
        await writeFile(`${file}.${process.pid}`, text, { mode: 0o700 }); await chmod(`${file}.${process.pid}`, 0o700); await rename(`${file}.${process.pid}`, file);
      }
      // Git hands the value to a shell when it holds anything a shell would interpret.
      return /^[\w/.+@-]+$/.test(path) ? path : quote(path);
    })().catch(error => { this.hooked = undefined; throw error; });
  }

  private async run(command: string, args: string[], signal: AbortSignal, timeoutMs = MOUNT_TIMEOUT_MS): Promise<CommandResult> {
    return workspaceCommand(command, args, this.store, signal, timeoutMs, process.env, this.processes, { keep: 'tail' });
  }
  /**
   * Deletes a tree nobody reads. `rm` does it, in a few processes: deleted by this process, a large checkout puts
   * every one of its files ahead of whatever else the process reads or writes, and holds that up for minutes.
   */
  private async discard(root: string): Promise<void> {
    const quiet = new AbortController().signal;
    // Three levels down, a checkout is in enough pieces for the processes to share.
    let pieces = [root];
    for (let level = 0; level < 3; level++) {
      pieces = (await Promise.all(pieces.map(async piece => (await readdir(piece, { withFileTypes: true }).catch(() => []))
        .filter(entry => entry.isDirectory()).map(entry => join(piece, entry.name))))).flat();
    }
    const batches: string[][] = [];
    while (pieces.length) batches.push(pieces.splice(0, 16));
    await Promise.all(Array.from({ length: REMOVAL_SLOTS }, async () => {
      for (let batch = batches.pop(); batch; batch = batches.pop()) await this.run('rm', ['-rf', '--', ...batch], quiet, REMOVAL_TIMEOUT_MS).catch(() => undefined);
    }));
    // What is left: the files above those pieces and the directories that held them.
    await this.delete(root, quiet);
  }
  private async delete(path: string, signal: AbortSignal): Promise<void> {
    const gone = await this.run('rm', ['-rf', '--', path], signal, REMOVAL_TIMEOUT_MS);
    if (gone.code) throw new Error(`Cannot delete ${path}: ${(gone.stderr || gone.stdout).trim().slice(-600) || `exit ${gone.code}`}`);
  }
  private async attach(lower: string, upper: string, work: string, at: string, signal: AbortSignal): Promise<void> {
    if ([lower, upper, work].some(path => /[,:]/.test(path))) throw new Error('Overlay workspaces need paths without commas or colons');
    const command = process.env.WORKFLOW_OVERLAY_COMMAND || 'fuse-overlayfs';
    const mounted = await this.run(command, ['-o', `lowerdir=${lower},upperdir=${upper},workdir=${work}`, at], signal)
      .catch((error: Error) => ({ code: -1, stdout: '', stderr: error.message }));
    if (mounted.code || await mountState(at) !== 'live') throw new Error(`${command} could not mount ${at}: ${(mounted.stderr || mounted.stdout).trim().slice(-600) || `exit ${mounted.code}`}`);
  }
  private async detach(at: string, signal: AbortSignal): Promise<void> {
    // A plain unmount fails while a process still stands in the directory; a lazy one lets go of it once they leave.
    for (const lazy of [[], ['-z']]) for (const tool of ['fusermount3', 'fusermount']) {
      if (await mountState(at) === 'none') return;
      await this.run(tool, ['-u', ...lazy, at], signal).catch(() => undefined);
    }
    if (await mountState(at) !== 'none') throw new Error(`Cannot unmount the overlay workspace at ${at}`);
  }

  /**
   * Whether overlays work here, tried once on the filesystem the workspaces will be on: a mount that reads is not
   * enough, since the filesystem under the upper directory may refuse what an overlay does to record a change.
   */
  probe(signal: AbortSignal): Promise<void> {
    return this.probed ??= this.tryOut(signal).catch(error => { this.probed = undefined; throw error; });
  }
  private async tryOut(signal: AbortSignal): Promise<void> {
    const dir = join(this.store, `probe-${process.pid}-${randomUUID().slice(0, 8)}`), at = join(dir, 'merged');
    try {
      if (process.platform !== 'linux') throw new Error('they need Linux');
      for (const name of ['lower/kept', 'upper', 'work', 'merged']) await mkdir(join(dir, name), { recursive: true, mode: 0o700 });
      await writeFile(join(dir, 'lower/moved'), 'base'); await writeFile(join(dir, 'lower/kept/gone'), 'base');
      await this.attach(join(dir, 'lower'), join(dir, 'upper'), join(dir, 'work'), at, signal);
      // What a member's work comes to: a new directory, a base file renamed, a base file deleted.
      await mkdir(join(at, 'made')); await rename(join(at, 'moved'), join(at, 'made/moved')); await unlink(join(at, 'kept/gone'));
      if (await readFile(join(at, 'made/moved'), 'utf8') !== 'base' || await exists(join(at, 'moved')) || await exists(join(at, 'kept/gone'))
        || !await exists(join(dir, 'lower/moved'))) throw new Error('changes made through the mount do not read back');
    } catch (error) {
      throw new Error(`Overlay workspaces are unavailable here: ${error instanceof Error ? error.message : String(error)}. They need /dev/fuse, fusermount3 and fuse-overlayfs (or the command WORKFLOW_OVERLAY_COMMAND names), and a filesystem under the workspace directory that such an overlay can keep its changes on.`);
    } finally {
      const quiet = new AbortController().signal;
      await this.detach(at, quiet).then(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }), () => undefined);
    }
  }

  private baseKey(source: Pick<OverlayOwner, 'commonDir'>, commit: string): string {
    return `${createHash('sha1').update(source.commonDir).digest('hex').slice(0, 16)}-${commit}`;
  }
  /**
   * The checkout of `commit` that overlays of it read, and the index every one of them starts from; made once however
   * many ask at the same time. The index says of each file that it is unchanged and of each directory what is
   * untracked in it, so a workspace's Git does not have to look.
   */
  base(source: Pick<OverlayOwner, 'commonDir'>, commit: string, signal: AbortSignal): Promise<{ tree: string; index: string }> {
    const key = this.baseKey(source, commit);
    const known = this.bases.get(key);
    if (known) return known;
    const made = this.build(key, source.commonDir, commit, signal).catch(error => { if (this.bases.get(key) === made) this.bases.delete(key); throw error; });
    this.bases.set(key, made);
    return made;
  }
  private async build(key: string, commonDir: string, commit: string, signal: AbortSignal): Promise<{ tree: string; index: string }> {
    const root = join(this.store, 'bases'), dir = join(root, key), made = { tree: join(dir, 'tree'), index: join(dir, 'git', 'index') };
    if (await exists(join(dir, 'ready'))) return made;
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Left by a service that stopped half way: a base it was building, or one it was deleting.
    for (const name of await readdir(root)) {
      const owner = /\.(?:tmp|gone)-(\d+)-/.exec(name);
      if (owner && !this.alive(Number(owner[1]))) void this.discard(join(root, name)).catch(() => undefined);
    }
    const tmp = `${dir}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`, tree = join(tmp, 'tree'), git = join(tmp, 'git');
    try {
      await mkdir(tree, { recursive: true, mode: 0o700 });
      await this.git(tmp, ['init', '--quiet', '--bare', git], signal);
      await writeFile(join(git, 'objects', 'info', 'alternates'), join(commonDir, 'objects') + '\n');
      await this.git(tmp, ['--git-dir', git, 'update-ref', '--no-deref', 'HEAD', commit], signal);
      const at = ['-c', 'index.version=2', '-c', 'index.skipHash=false', '-c', 'core.splitIndex=false', '--git-dir', git, '--work-tree', tree];
      await this.git(tmp, [...at, 'read-tree', commit], signal);
      const release = await this.slot(signal);
      try { await this.checkout(tmp, tree, at, signal); } finally { release(); }
      // A status with the hook and the untracked cache on records what is untracked in each directory: nothing.
      const hook = await this.hook();
      const look = (allowFailure = false) => this.git(tmp, ['-c', `core.fsmonitor=${hook}`, '-c', 'core.fsmonitorHookVersion=2', '-c', 'core.untrackedCache=true', ...at, 'status', '--porcelain'], signal, allowFailure);
      const plain = await readFile(join(git, 'index')), marked = unchangedIndex(plain, BASE_TOKEN);
      let status: CommandResult | undefined;
      if (marked) {
        await writeFile(join(git, 'index'), marked);
        status = await look(true);
        if (status.code) { await writeFile(join(git, 'index'), plain); status = undefined; }
      }
      // An index that could not be marked is left to Git: one status reads every file, a second marks them unchanged.
      if (!status) { status = await look(); await look(); }
      if (status.stdout.trim()) throw new Error(`The checkout of ${commit} does not match the commit: ${status.stdout.trim().slice(0, 400)}`);
      await writeFile(join(tmp, 'ready'), commit + '\n');
      // Another service may have made the same base meanwhile; either one will do.
      await rename(tmp, dir).catch(async error => { if (!await exists(join(dir, 'ready'))) throw error; });
    } finally { if (await exists(tmp)) void this.discard(tmp).catch(() => undefined); }
    return made;
  }
  /**
   * Writes the files of the index into the empty `tree`. One Git process, however many workers it is given, first
   * looks for every file and makes every directory itself, one after another, and only then hands out the writing: on
   * a network filesystem that wait is most of a large checkout. Here several processes each write a stretch of the
   * paths from start to end.
   */
  private async checkout(cwd: string, tree: string, at: string[], signal: AbortSignal): Promise<void> {
    const stretches: string[][] = [];
    let room = 0, plain = true;
    await this.git(cwd, [...at, 'ls-files', '-z'], signal, false, { scan: records(path => {
      const size = Buffer.byteLength(path) + 1;
      // A name that is not UTF-8 does not survive a command line.
      if (path.includes('\uFFFD')) plain = false;
      if (!stretches.length || stretches.at(-1)!.length >= BASE_CHECKOUT_PATHS || room < size) { stretches.push([]); room = BASE_CHECKOUT_BYTES; }
      stretches.at(-1)!.push(path); room -= size;
    }) });
    if (!plain || stretches.length < 2) {
      await this.git(cwd, ['-c', `checkout.workers=${BASE_CHECKOUT_WORKERS}`, ...at, 'checkout-index', '--all'], signal);
      return;
    }
    // Git makes the directories of the files it writes, and gives up when another process makes one at the same
    // moment. The paths are sorted, so a directory two processes write into holds the end of one stretch and the
    // start of the next: those are made before any of them starts.
    for (let next = 1; next < stretches.length; next++) {
      const before = stretches[next - 1]!.at(-1)!.split('/'), after = stretches[next]![0]!.split('/');
      let shared = 0;
      while (shared < before.length - 1 && shared < after.length - 1 && before[shared] === after[shared]) shared++;
      if (shared) await mkdir(join(tree, ...after.slice(0, shared)), { recursive: true });
    }
    const stop = new AbortController(), halt = () => stop.abort();
    signal.addEventListener('abort', halt, { once: true });
    if (signal.aborted) halt();
    let taken = 0, failure: unknown;
    try {
      await Promise.all(Array.from({ length: Math.min(BASE_CHECKOUT_WORKERS, stretches.length) }, async () => {
        for (let paths = stretches[taken++]; paths && !stop.signal.aborted; paths = stretches[taken++]) {
          // The first to fail is the reason; the others are stopped, and waited for before the tree is given up.
          await this.git(cwd, [...at, 'checkout-index', '--', ...paths], stop.signal).catch(error => { failure ??= error; stop.abort(); });
        }
      }));
    } finally { signal.removeEventListener('abort', halt); }
    signal.throwIfAborted();
    if (failure) throw failure;
  }
  private alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  /** Deletes a base tree no workspace reads any more. Its name is free at once; the files go in the background. */
  async retire(source: Pick<OverlayOwner, 'commonDir'>, commit: string): Promise<void> {
    const key = this.baseKey(source, commit), dir = join(this.store, 'bases', key);
    await this.bases.get(key)?.catch(() => undefined);
    this.bases.delete(key);
    const gone = `${dir}.gone-${process.pid}-${randomUUID().slice(0, 8)}`;
    if (await rename(dir, gone).then(() => true, () => false)) void this.discard(gone).catch(() => undefined);
  }

  /** Empties what a workspace keeps, mount included, and gives it the directories a new overlay starts from. */
  async prepare(ws: OverlayOwner, signal: AbortSignal): Promise<OverlayPlace> {
    await this.remove(ws, signal);
    const place = this.place(ws);
    for (const dir of [place.upper, place.work, ws.path]) await mkdir(dir, { recursive: true, mode: 0o700 });
    return place;
  }
  /** Points a new workspace's repository at the hook and gives it the base's index; then its Git has nothing to scan. */
  async adopt(ws: OverlayOwner, base: { tree: string; index: string }, signal: AbortSignal): Promise<void> {
    const place = this.place(ws);
    await writeFile(join(place.git, 'bridge-overlay'), JSON.stringify({ upper: place.upper, lower: base.tree }));
    for (const [name, value] of [['core.fsmonitor', await this.hook()], ['core.fsmonitorHookVersion', '2'], ['core.untrackedCache', 'true']] as const) {
      await this.git(place.upper, ['config', name, value], signal);
    }
    // `clone --separate-git-dir` must not pin the upper directory as the worktree: the worktree is the mount.
    await this.git(place.upper, ['config', '--unset-all', 'core.worktree'], signal, true);
    await writeFile(join(place.git, 'index'), relocateIndex(await readFile(base.index), await realpath(ws.path)));
  }
  /** Mounts the workspace unless it is mounted and served; a mount whose process died is replaced. */
  mount(ws: OverlayOwner, signal: AbortSignal): Promise<void> {
    const running = this.mounting.get(ws.path);
    if (running) return running;
    const mounting = (async () => {
      const state = await mountState(ws.path);
      if (state === 'live') return;
      const place = this.place(ws);
      if (!await exists(join(place.upper, '.git'))) throw new Error(`Overlay workspace has lost its files: ${place.home}`);
      // The base is made again if it was lost: it holds nothing that is not in the commit.
      const base = await this.base(ws, ws.baseCommit, signal);
      if (state === 'dead') await this.detach(ws.path, signal);
      await mkdir(ws.path, { recursive: true, mode: 0o700 });
      await this.attach(base.tree, place.upper, place.work, ws.path, signal);
    })().finally(() => { if (this.mounting.get(ws.path) === mounting) this.mounting.delete(ws.path); });
    this.mounting.set(ws.path, mounting);
    return mounting;
  }
  /** Unmounts a workspace and deletes what it kept. The mount point is left, empty, for the caller to remove. */
  async remove(ws: Pick<OverlayOwner, 'workflowId' | 'id' | 'path'>, signal: AbortSignal): Promise<void> {
    await this.mounting.get(ws.path)?.catch(() => undefined);
    await this.detach(ws.path, signal);
    await this.delete(this.place(ws).home, signal);
  }
}
