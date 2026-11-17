import { mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { workflowDigest } from './digest';
import type { WorkflowLogger, WorkflowView } from './types';

/** Names the scratch directory to the worker, whatever else sets TMPDIR on the way. */
export const SCRATCH_ENV = 'AGENT_WORKFLOW_SCRATCH';

/** Tasks that will not run again; a one-shot worker's scratch directory is not needed after one. */
const OVER = new Set(['result_ready', 'cancelled']);

/** Paths stay short: tools put Unix sockets under TMPDIR, and a socket path holds about a hundred bytes. */
const short = (id: string, length: number) => id.replace(/-/g, '').slice(0, length);
const workflowDir = (workflowId: string) => short(workflowId, 12);

/**
 * The directory name of a session's scratch space inside its workflow's. A member's carries its name, so disk use can
 * be read off a listing; a one-shot worker's is `task-…`.
 */
export function scratchSlot(sessionRef: string, member?: string): string {
  const label = member === undefined ? 'task' : member.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\./, '_').slice(0, 24) || 'member';
  return `${label}-${short(sessionRef, 8)}`;
}

/**
 * The scratch directories of a workflow that are still owned: those of members that have not been retired, of
 * one-shot workers whose task may still run, and of any session with a turn in flight.
 */
export function scratchSlots(state: WorkflowView): Set<string> {
  const retired = new Set<string>(), staffed = new Set<string>();
  for (const swarm of state.swarms ?? []) for (const member of swarm.members) (member.stopped === 'retired' ? retired : staffed).add(member.name);
  const members = new Map((state.agents ?? []).map(agent => [agent.sessionRef, agent.key] as const));
  const slots = new Set<string>();
  for (const [sessionRef, key] of members) if (!retired.has(key) || staffed.has(key)) slots.add(scratchSlot(sessionRef, key));
  for (const task of state.tasks) if (!OVER.has(task.status)) slots.add(scratchSlot(task.sessionRef, members.get(task.sessionRef)));
  return slots;
}

export interface ScratchLease {
  path: string;
  /** What the worker process inherits: the directory as its temporary directory. */
  env: Record<string, string>;
  /**
   * Ends this turn's use. `remove` deletes the directory now; otherwise it stays for the session's next turn, unless
   * it is empty. `running` says the worker process outlives the turn, so even an empty directory is left in place.
   */
  release(options?: { remove?: boolean; running?: boolean }): void;
}

/**
 * A private temporary directory for each worker session, in place of the machine's shared one. The engine makes the
 * directory, hands it to the worker as TMPDIR, and deletes it when its owner is gone: that is what keeps the files of
 * many workers apart, shows whose they are, and returns the disk when the work is over. Nothing here stops a worker
 * that writes to another path by name.
 *
 * Layout: `<root>/<store>/<workflow>/<slot>`. `<store>` separates the runtimes that share `root`, since each reclaims
 * whatever it does not own below its own directory.
 */
export class WorkflowScratch {
  private readonly root: string;
  private readonly held = new Map<string, number>();
  private readonly removing = new Map<string, Promise<void>>();
  private sweeping = false;

  constructor(root: string, store: string, private readonly log: WorkflowLogger) {
    this.root = join(resolve(root), workflowDigest(store).slice(0, 8));
  }

  async acquire(workflowId: string, slot: string): Promise<ScratchLease> {
    const path = join(this.root, workflowDir(workflowId), slot);
    this.held.set(path, (this.held.get(path) ?? 0) + 1);
    try {
      // A removal under way finishes first, so the worker never starts in a directory that is being emptied.
      await Promise.all([...this.removing].filter(([target]) => this.within(path, target)).map(([, pending]) => pending));
      await mkdir(path, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.drop(path);
      throw error;
    }
    let released = false;
    return {
      path,
      env: { TMPDIR: path, TMP: path, TEMP: path, [SCRATCH_ENV]: path },
      release: ({ remove = false, running = false } = {}) => {
        if (released) return;
        released = true;
        this.drop(path);
        if (this.held.has(path) || running) return;
        void this.remove(path, !remove).then(() => this.tidy(dirname(path)));
      },
    };
  }

  /**
   * Deletes every directory nobody owns any more. `owners` maps each unfinished workflow to its owned slots (see
   * scratchSlots), or to undefined when they cannot be told, which keeps all of that workflow's. Directories of
   * workflows that are not listed belong to finished ones.
   */
  async reclaim(owners: ReadonlyMap<string, ReadonlySet<string> | undefined>): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const workflows = new Map([...owners].map(([workflowId, slots]) => [workflowDir(workflowId), slots] as const));
      for (const workflow of await this.list(this.root)) {
        const path = join(this.root, workflow);
        if (!workflows.has(workflow)) { await this.remove(path); continue; }
        const slots = workflows.get(workflow);
        if (!slots) continue;
        for (const slot of await this.list(path)) if (!slots.has(slot)) await this.remove(join(path, slot));
        await rmdir(path).catch(() => {});
      }
      await rmdir(this.root).catch(() => {});
    } finally { this.sweeping = false; }
  }

  private drop(path: string): void {
    const count = (this.held.get(path) ?? 1) - 1;
    if (count > 0) this.held.set(path, count); else this.held.delete(path);
  }

  private within(path: string, parent: string): boolean { return path === parent || path.startsWith(parent + sep); }

  private async list(path: string): Promise<string[]> {
    return readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') this.log.warn('scratch-list-failed', { path, error: String(error) });
      return [];
    });
  }

  /**
   * Deletes a directory below the root unless a running turn uses it or something inside it; with `ifEmpty`, only an
   * empty one. Either way a turn that starts meanwhile waits for it (see acquire).
   */
  private async remove(path: string, ifEmpty = false): Promise<void> {
    if (!this.within(path, this.root) || path === this.root) throw new Error('Scratch path is outside the scratch root');
    if ([...this.held.keys()].some(held => this.within(held, path))) return;
    const known = this.removing.get(path);
    if (known) return known;
    const pending = (ifEmpty ? rmdir(path).catch(() => {}) : rm(path, { recursive: true, force: true, maxRetries: 2 })
      .then(() => this.log.info('scratch-removed', { path }), error => this.log.warn('scratch-remove-failed', { path, error: String(error) })))
      .finally(() => this.removing.delete(path));
    this.removing.set(path, pending);
    return pending;
  }

  /** Removes the workflow's directory, then the store's, once they are empty. */
  private async tidy(workflowPath: string): Promise<void> {
    await rmdir(workflowPath).then(() => rmdir(this.root), () => {}).catch(() => {});
  }
}
