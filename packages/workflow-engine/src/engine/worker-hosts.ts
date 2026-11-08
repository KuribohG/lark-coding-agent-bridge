import type Database from 'better-sqlite3';
import type { WorkflowTask } from './types';

/**
 * Worker processes that may outlive this host process (WorkerRunner.hosting).
 * A row lives from spawn until its turn ends for a reason other than shutdown,
 * so rows found at startup name processes a replayed turn can reattach to.
 */
export interface WorkerHostRecord {
  hostKey: string;
  workflowId: string;
  /** Identifies the logical turn; a replayed call with the same match continues this process. */
  match: string;
  taskId: string;
  agentKind: string;
  /** Hash of the IPC token in the process environment; a reattached turn keeps accepting it. */
  tokenHash: string;
  createdAt: number;
  /** The turn cannot continue in this process (e.g. its work claim was released). */
  discard: boolean;
}

/** Replays reuse the cache key of one-shot calls and the task itself for member and managed turns. */
export function hostMatch(task: WorkflowTask): string {
  return task.cacheKey ?? task.taskId;
}

interface Row {
  host_key: string; workflow_id: string; match_key: string; task_id: string; agent_kind: string;
  token_hash: string; created_at: number; discard: number;
}

export class WorkerHosts {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_worker_hosts (host_key TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, match_key TEXT NOT NULL,
        task_id TEXT NOT NULL, agent_kind TEXT NOT NULL, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, discard INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS workflow_worker_host_match ON workflow_worker_hosts(workflow_id, match_key);
    `);
  }

  /** One process per logical turn: a new process (JSON restatement, fresh start) replaces the previous row. */
  put(record: Omit<WorkerHostRecord, 'discard'>): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workflow_worker_hosts WHERE (workflow_id = ? AND match_key = ?) OR host_key = ?')
        .run(record.workflowId, record.match, record.hostKey);
      this.db.prepare(`INSERT INTO workflow_worker_hosts(host_key, workflow_id, match_key, task_id, agent_kind, token_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.hostKey, record.workflowId, record.match, record.taskId, record.agentKind, record.tokenHash, record.createdAt);
    })();
  }

  find(workflowId: string, match: string): WorkerHostRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_worker_hosts WHERE workflow_id = ? AND match_key = ?').get(workflowId, match) as Row | undefined;
    return row && toRecord(row);
  }

  list(): WorkerHostRecord[] {
    return (this.db.prepare('SELECT * FROM workflow_worker_hosts').all() as Row[]).map(toRecord);
  }

  discardTasks(workflowId: string, taskIds: Iterable<string>): void {
    const discard = this.db.prepare('UPDATE workflow_worker_hosts SET discard = 1 WHERE workflow_id = ? AND task_id = ?');
    for (const taskId of taskIds) discard.run(workflowId, taskId);
  }

  remove(hostKey: string): void {
    this.db.prepare('DELETE FROM workflow_worker_hosts WHERE host_key = ?').run(hostKey);
  }
}

function toRecord(row: Row): WorkerHostRecord {
  return { hostKey: row.host_key, workflowId: row.workflow_id, match: row.match_key, taskId: row.task_id,
    agentKind: row.agent_kind, tokenHash: row.token_hash, createdAt: row.created_at, discard: row.discard !== 0 };
}
