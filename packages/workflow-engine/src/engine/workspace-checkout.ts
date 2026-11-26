import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult } from './workspace-process';

/** Git as the workspace service runs it, with variables of its own for one command. Options (`-c`) lead the arguments. */
export type CheckoutGit = (cwd: string, args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv) => Promise<CommandResult>;

/** The entries one Git process is given to write at a time. */
const STRETCH_ENTRIES = 500;
/** A checkout of fewer entries is written by Git alone, as fast as several processes would start. */
const LARGE_ENTRIES = 2000;
/** Makes Git write an index whose entries can be taken apart and put back: whole, uncompressed and hashed. */
const PLAIN_INDEX = ['-c', 'index.version=2', '-c', 'index.skipHash=false', '-c', 'core.splitIndex=false', '-c', 'index.sparse=false'];
/** What an entry holds before its object ID: the times, device, inode, mode, owner and size of the file it was written as. */
const STAT_BYTES = 40;
/**
 * How often a stretch is given to a process before the checkout is given up. One process among the tens of thousands
 * that write the worktrees of a swarm is now and then killed without a word; writing its files again costs a second.
 */
const STRETCH_ATTEMPTS = 3;

/**
 * Where each entry of an index starts, and after them where the last one ends. Nothing for an index that is not
 * version 2 or 3 with a SHA-1 that matches: the entries of any other are not fixed records with the path in full.
 */
function indexEntries(index: Buffer): Uint32Array | undefined {
  if (index.length < 32 || index.toString('latin1', 0, 4) !== 'DIRC' || ![2, 3].includes(index.readUInt32BE(4))) return undefined;
  const body = index.subarray(0, index.length - 20);
  if (!createHash('sha1').update(body).digest().equals(index.subarray(index.length - 20))) return undefined;
  const count = index.readUInt32BE(8), starts = new Uint32Array(count + 1);
  // An entry is a fixed header, the path and its NUL, padded to a multiple of eight bytes.
  let at = 12;
  for (let entry = 0; entry < count; entry++) {
    starts[entry] = at;
    if (at + 62 > body.length) return undefined;
    const [, end] = entryPath(body, at);
    if (end < 0 || end >= body.length) return undefined;
    at += (end - at + 8) & ~7;
  }
  if (at > body.length) return undefined;
  starts[count] = at;
  return starts;
}
/** Where the path of the entry at `at` starts and ends. */
function entryPath(index: Buffer, at: number): [start: number, end: number] {
  const flags = index.readUInt16BE(at + 60), start = at + 62 + (flags & 0x4000 ? 2 : 0);
  return [start, (flags & 0xfff) < 0xfff ? start + (flags & 0xfff) : index.indexOf(0, start)];
}
const sealed = (body: Buffer) => Buffer.concat([body, createHash('sha1').update(body).digest()]);

/** Whether the Git behind each service reads attributes from a tree it is told (`--attr-source`, Git 2.41); asked once. */
const attributeSources = new WeakMap<CheckoutGit, Promise<boolean>>();
function readsAttributesOf(git: CheckoutGit, tree: string, commit: string, signal: AbortSignal): Promise<boolean> {
  let known = attributeSources.get(git);
  if (!known) {
    known = git(tree, [`--attr-source=${commit}`, 'rev-parse', '--git-dir'], signal).then(() => true, error => {
      // A command that was stopped says nothing about the option.
      if (signal.aborted) { attributeSources.delete(git); throw error; }
      return false;
    });
    attributeSources.set(git, known);
  }
  return known;
}

const indexOf = async (git: CheckoutGit, tree: string, signal: AbortSignal) => join((await git(tree, ['rev-parse', '--absolute-git-dir'], signal)).stdout.trim(), 'index');

/**
 * Whether the checkout of `commit` in a worktree that holds none of its files is one for `writeCheckout`: large, and
 * not sparse. Unless it is sparse, the index is left naming every file of the commit with none of them written,
 * which is where `writeCheckout` starts, and Git alone as well.
 */
export async function largeCheckout(git: CheckoutGit, tree: string, commit: string, signal: AbortSignal): Promise<boolean> {
  // A worktree takes after a sparse checkout it was added from. Which files that leaves out Git settles only as it
  // writes the worktree itself.
  if ((await git(tree, ['config', '--type=bool', '--default=false', '--get', 'core.sparseCheckout'], signal)).stdout.trim() === 'true') return false;
  await git(tree, [...PLAIN_INDEX, 'read-tree', '--reset', commit], signal);
  // The index of a large checkout is tens of megabytes; how many entries it has is in its first bytes.
  const file = await open(await indexOf(git, tree, signal), 'r'), header = Buffer.alloc(12);
  try { if ((await file.read(header, 0, 12, 0)).bytesRead < 12) return false; } finally { await file.close(); }
  return header.toString('latin1', 0, 4) === 'DIRC' && header.readUInt32BE(8) >= LARGE_ENTRIES;
}

/**
 * Writes the files of `commit` into a worktree whose index `largeCheckout` left, with several Git processes at once,
 * and leaves the index as one Git process would have: every entry with the size and times of the file as it was
 * written, so the first `git status` reads no file. Returns false when it wrote nothing because the index is of a
 * kind it does not take apart or Git cannot be told where the attributes are; the caller then has Git write it alone.
 * When it returns true every file is known to be there: each process said it wrote its stretch, and gave back every
 * entry of it with the time of a file it had just written, which no entry has before.
 *
 * One Git process writes a large checkout file by file, and on a network filesystem each file takes several round
 * trips: 130,000 files took twenty minutes however many other checkouts ran beside it, and half a minute this way.
 * The entries of the index are sorted by path. Each process is given a stretch of them as an index of its own,
 * writes those files and records what it wrote there; the stretches are then put back in place of the entries they
 * were cut from, which differ only in what the process recorded.
 */
export async function writeCheckout(git: CheckoutGit, tree: string, commit: string, processes: number, signal: AbortSignal): Promise<boolean> {
  const path = await indexOf(git, tree, signal);
  const index = await readFile(path), starts = indexEntries(index);
  if (!starts) return false;
  const count = starts.length - 1;
  // Git reads the attributes of a path (line endings, encodings) from the `.gitattributes` files in the worktree or
  // else in the index, and a process here has neither of those that another process is to write. Each is told to
  // read them from the commit; a Git that cannot leaves a checkout that has any to be written by one process.
  const named = (entry: number) => { const [start, end] = entryPath(index, starts[entry]!); return index.toString('latin1', start, end); };
  const attributed = await readsAttributesOf(git, tree, commit, signal);
  if (!attributed) for (let entry = 0; entry < count; entry++) if (/(?:^|\/)\.gitattributes$/.test(named(entry))) return false;
  const checkout = [...(attributed ? [`--attr-source=${commit}`] : []), ...PLAIN_INDEX, 'checkout-index', '--index', '--force', '--all'];
  const stretches: Array<[first: number, end: number]> = [];
  for (let first = 0; first < count; first += STRETCH_ENTRIES) stretches.push([first, Math.min(count, first + STRETCH_ENTRIES)]);
  // Git makes the directories of the files it writes, and gives up when another process makes one at the same
  // moment. The files of a directory are neighbours in the index, so one that two processes write into holds the end
  // of one stretch and the start of the next: those are made before any process starts.
  for (let next = 1; next < stretches.length; next++) {
    const before = named(stretches[next]![0] - 1).split('/'), after = named(stretches[next]![0]).split('/');
    let shared = 0;
    while (shared < before.length - 1 && shared < after.length - 1 && before[shared] === after[shared]) shared++;
    // A path is bytes; Latin-1 carries them through a string and back unchanged.
    if (shared) await mkdir(Buffer.concat([Buffer.from(tree + '/'), Buffer.from(after.slice(0, shared).join('/'), 'latin1')]), { recursive: true });
  }
  const scratch = await mkdtemp(join(tmpdir(), 'workflow-checkout-'));
  const merged = Buffer.from(index);
  const stop = new AbortController(), halt = () => stop.abort();
  signal.addEventListener('abort', halt, { once: true });
  if (signal.aborted) halt();
  let taken = 0, failure: unknown;
  const write = async (stretch: number): Promise<void> => {
    const [first, end] = stretches[stretch]!, from = starts[first]!, to = starts[end]!;
    const header = Buffer.from(index.subarray(0, 12)); header.writeUInt32BE(end - first, 8);
    let own = '';
    for (let attempt = 1; ; attempt++) {
      // An index of its own for each attempt: a process that was killed may have left the lock of its index behind.
      own = join(scratch, `${stretch}.${attempt}`);
      await writeFile(own, sealed(Buffer.concat([header, index.subarray(from, to)])));
      // Writing the files of a stretch again replaces what the process before it wrote of them.
      try { await git(tree, checkout, stop.signal, { GIT_INDEX_FILE: own }); break; } catch (error) {
        if (stop.signal.aborted || attempt >= STRETCH_ATTEMPTS) throw error;
      }
    }
    const written = await readFile(own), places = indexEntries(written);
    if (!places || places.length - 1 !== end - first || places[end - first]! - 12 !== to - from) throw new Error('Git rewrote the entries of a checkout stretch');
    // Only what Git recorded of each file is taken from it; an entry that came back otherwise is not the one cut out.
    for (let entry = 0; entry < end - first; entry++) {
      const at = places[entry]!, next = places[entry + 1]!;
      if (!written.subarray(at + STAT_BYTES, next).equals(index.subarray(from + at - 12 + STAT_BYTES, from + next - 12))) throw new Error('Git rewrote the entries of a checkout stretch');
      // The time a file was last written, in seconds, is the third field of an entry, and of no entry before its file is.
      if (!written.readUInt32BE(at + 8)) throw new Error('Git did not write every file of a checkout stretch');
    }
    written.copy(merged, from, 12, places[end - first]!);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(processes, stretches.length) }, async () => {
      // The first to fail is the reason; the others are stopped, and waited for before the checkout is given up.
      for (let stretch = taken++; stretch < stretches.length && !stop.signal.aborted; stretch = taken++) {
        await write(stretch).catch(error => { failure ??= error; stop.abort(); });
      }
    }));
    signal.throwIfAborted();
    if (failure) throw failure;
    // Nothing else reads the index of a worktree that is still being made, so it is replaced without Git's lock.
    await writeFile(path + '.checkout', sealed(merged.subarray(0, merged.length - 20)));
    await rename(path + '.checkout', path);
  } finally {
    signal.removeEventListener('abort', halt);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  return true;
}
