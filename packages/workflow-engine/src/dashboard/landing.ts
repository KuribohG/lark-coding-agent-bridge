import Database from 'better-sqlite3';
import { workflowDigest } from '../engine/digest';
import type { LandingHead, LandingLive, LandingOverride, LandingTrain, WorkspaceLanding } from '../engine/workspace-types';

/** What the workspace service wrote about a workflow's landing, as it is in the store. */
export interface LandingRecord {
  /** The landing the script configured, and what the main agent changed about it. */
  landing?: WorkspaceLanding;
  override?: LandingOverride;
  /** The commit of each repository's landing branch the queue vouches for; the repository when a worktree of it is on record. */
  heads: Array<LandingHead & { repository?: string }>;
  /** The queues as they stand; none from a service that does not write them. */
  live: LandingLive[];
  /** The latest runs of the trains, newest first. */
  trains: LandingTrain[];
}

/**
 * Reads what the workspace service keeps about landings. That is a store of its own beside the workflow store, and
 * like the journal it is opened read-only and belongs to another process. It exists once a workflow has made a
 * workspace, and an older service wrote fewer tables into it: whatever is missing reads as nothing.
 */
export class LandingRecords {
  private db: Database.Database | undefined;

  /** `path` is that of the workspace store; `beside` names it for a workflow store. */
  constructor(private readonly path: string) {}

  static beside(workflowStore: string): LandingRecords {
    return new LandingRecords(workflowStore + '.workspaces.sqlite');
  }

  private open(): Database.Database | undefined {
    if (this.db) return this.db;
    try { this.db = new Database(this.path, { readonly: true, fileMustExist: true }); } catch { return undefined; }
    return this.db;
  }

  private rows<T>(table: string, sql: string, ...args: unknown[]): T[] {
    const db = this.open();
    if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return [];
    return db.prepare(sql).all(...args) as T[];
  }

  /** Changes whenever the store was written to, so an answer made from it is told from the one before. */
  version(): string {
    try { return String(this.open()?.pragma('data_version', { simple: true }) ?? 'none'); } catch { return 'unread'; }
  }

  read(workflowId: string, trains: number): LandingRecord {
    const parse = <T>(row: { data: string }): T => JSON.parse(row.data) as T;
    const records = this.rows<{ key: string; data: string }>('workspace_records', "SELECT key, data FROM workspace_records WHERE workflow = ? AND key LIKE '@landing%' ORDER BY key", workflowId);
    const one = <T>(key: string): T | undefined => { const row = records.find(found => found.key === key); return row && parse<T>(row); };
    const landing = one<WorkspaceLanding>('@landing'), override = one<LandingOverride>('@landing-override');
    // A head is kept under a digest of its repository's Git directory, which the worktrees of that repository name.
    const made = this.rows<{ repository: string | null; commonDir: string | null }>('workspace_records',
      "SELECT DISTINCT json_extract(data,'$.repository') AS repository, json_extract(data,'$.commonDir') AS commonDir FROM workspace_records WHERE workflow = ? AND kind = 'workspace'", workflowId);
    const repositories = new Map<string, string>(made.flatMap(row => row.repository && row.commonDir ? [[`@landing-head/${workflowDigest(row.commonDir).slice(0, 16)}`, row.repository] as const] : []));
    return {
      ...(landing ? { landing } : {}), ...(override ? { override } : {}),
      heads: records.filter(row => row.key.startsWith('@landing-head/')).map(row => ({ ...parse<LandingHead>(row), ...(repositories.has(row.key) ? { repository: repositories.get(row.key)! } : {}) })),
      live: this.rows<{ at: number; data: string }>('landing_live', 'SELECT at, data FROM landing_live WHERE workflow = ? ORDER BY repository', workflowId).map(row => ({ ...parse<Omit<LandingLive, 'at'>>(row), at: row.at })),
      trains: this.rows<{ data: string }>('landing_trains', 'SELECT data FROM landing_trains WHERE workflow = ? ORDER BY id DESC LIMIT ?', workflowId, trains).map(row => parse<LandingTrain>(row)),
    };
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
