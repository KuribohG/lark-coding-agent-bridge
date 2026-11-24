import { WorkflowStore, type WorkflowArchive } from '../engine/kernel-store';
import type { WorkflowState } from '../engine/types';

/** One workflow as the catalog lists it, whether or not its state has been read. */
export interface CatalogRow {
  id: string;
  scope: string;
  rootId: string;
  parentId?: string;
  status: string;
  updatedAt: number;
}

/** One entry of a workflow's journal that the writer has not compacted away yet. */
export interface JournalEntry {
  seq: number;
  at: number;
  type: string;
  entity?: string;
}

const TERMINAL = new Set(['completed', 'cancelled']);
/** Detached copies kept of workflows that can no longer change; the store keeps their state for longer than this. */
const KEEP_FINISHED = 8;

/**
 * Reads a workflow store that another process owns. The file is opened read-only and followed through its journal,
 * so the process that runs the workflows is never asked for anything: it may be restarted, upgraded or absent, and
 * nothing read here can change what it does.
 *
 * The reducer that replays the journal is the one this build was made with. A journal written by a later build may
 * hold events it does not know; reading such a workflow throws WorkflowJournalError, and the others are unaffected.
 */
export class WorkflowJournal {
  private readonly store: WorkflowStore;
  /** The detached copy handed out for each workflow, and the journal position it was made at. */
  private readonly copies = new Map<string, { seq: number; state: WorkflowState }>();

  constructor(readonly path: string) {
    // Finished workflows are read to list them and seldom again; few of their states need to stay in memory.
    this.store = new WorkflowStore(path, Date.now, { readonly: true, retainFinished: KEEP_FINISHED });
  }

  private get db() { return this.store.db; }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  /**
   * The journal position of the latest commit that changed any workflow. It only grows: the writer deletes entries
   * that a snapshot covers, but never reuses their positions. Lease renewals do not move it: a lease is not a change
   * of state.
   */
  position(): number {
    if (!this.hasTable('wf_events')) return 0;
    return (this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'wf_events'").get() as { seq: number } | undefined)?.seq ?? 0;
  }

  /** Every workflow that is not finished, then the finished roots, most recently changed first. */
  catalog(finished = 50): { rows: CatalogRow[]; finished: number } {
    if (!this.hasTable('wf_catalog')) return { rows: [], finished: 0 };
    const select = 'SELECT id, scope, root_id AS rootId, parent_id AS parentId, status, updated_at AS updatedAt FROM wf_catalog';
    const open = this.db.prepare(`${select} WHERE status NOT IN ('completed', 'cancelled') ORDER BY rowid DESC`).all() as CatalogRow[];
    const done = this.db.prepare(`${select} WHERE status IN ('completed', 'cancelled') AND parent_id IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(finished) as CatalogRow[];
    const total = (this.db.prepare("SELECT count(*) AS total FROM wf_catalog WHERE status IN ('completed', 'cancelled') AND parent_id IS NULL").get() as { total: number }).total;
    return { rows: [...open, ...done].map(row => ({ ...row, parentId: row.parentId ?? undefined })), finished: total };
  }

  /** The workflows of one tree, the root first. */
  tree(rootId: string): CatalogRow[] {
    if (!this.hasTable('wf_catalog')) return [];
    return (this.db.prepare('SELECT id, scope, root_id AS rootId, parent_id AS parentId, status, updated_at AS updatedAt FROM wf_catalog WHERE root_id = ? ORDER BY rowid')
      .all(rootId) as CatalogRow[]).map(row => ({ ...row, parentId: row.parentId ?? undefined }));
  }

  /**
   * A detached copy of the workflow as the journal has it now, in the shape hosts are given (texts load when read).
   * The same object is returned until the workflow changes; callers must not change it.
   */
  state(workflowId: string): { state: WorkflowState; seq: number } | undefined {
    const followed = this.store.follow(workflowId);
    if (!followed) return undefined;
    const known = this.copies.get(workflowId);
    if (known?.seq === followed.seq) return known;
    const copy = { seq: followed.seq, state: this.store.public(followed.state) };
    this.copies.delete(workflowId);
    this.copies.set(workflowId, copy);
    let finished = [...this.copies].filter(([, entry]) => TERMINAL.has(entry.state.status)).length;
    for (const [id, entry] of this.copies) {
      if (finished <= KEEP_FINISHED) break;
      if (id !== workflowId && TERMINAL.has(entry.state.status)) { this.copies.delete(id); finished--; }
    }
    return copy;
  }

  /** Entries that left the workflow's state: old posts, finished work items and turns, by ID, key or position. */
  archive(workflowId: string): WorkflowArchive {
    return this.store.archive(workflowId);
  }

  /** A text stored out of line (a task's prompt, an artifact) by its digest. */
  text(digest: string): string {
    return this.store.text(digest);
  }

  /** The latest journal entries of a workflow, newest first. Entries its snapshot covers are deleted by the writer. */
  recent(workflowId: string, limit: number, before?: number): JournalEntry[] {
    if (!this.hasTable('wf_events')) return [];
    return (this.db.prepare('SELECT seq, at, type, entity FROM wf_events WHERE workflow_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(workflowId, before ?? Number.MAX_SAFE_INTEGER, limit) as Array<JournalEntry & { entity: string | null }>)
      .map(row => ({ seq: row.seq, at: row.at, type: row.type, ...(row.entity ? { entity: row.entity } : {}) }));
  }

  close(): void {
    this.store.close();
  }
}
