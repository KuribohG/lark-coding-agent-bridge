import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { settleEventWaits } from './event-waits';
import type { WorkflowState } from './types';

/** SQLite persistence for workflow states, idempotent main-agent operations and the controller heartbeat. */
export class WorkflowStore {
  readonly db: Database.Database;
  private readonly changes = new EventEmitter().setMaxListeners(0);

  constructor(path: string, private readonly now: () => number) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS workflow_binding ON workflows(scope) WHERE status NOT IN ('completed', 'cancelled');
      CREATE TABLE IF NOT EXISTS workflow_operations (scope TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
        response TEXT NOT NULL, PRIMARY KEY(scope, id));
      CREATE TABLE IF NOT EXISTS workflow_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    if (!(this.db.prepare('PRAGMA table_info(workflows)').all() as Array<{name:string}>).some(column => column.name === 'root_id')) {
      this.db.exec('ALTER TABLE workflows ADD COLUMN root_id TEXT; UPDATE workflows SET root_id = id;');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS workflow_root ON workflows(root_id)');
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  heartbeat(): number {
    return Number((this.db.prepare("SELECT value FROM workflow_meta WHERE key = 'heartbeat'").get() as { value: string } | undefined)?.value);
  }

  writeHeartbeat(at: number): void {
    this.db.prepare("INSERT INTO workflow_meta(key, value) VALUES ('heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(at));
  }

  list(): WorkflowState[] {
    return (this.db.prepare("SELECT data FROM workflows WHERE status NOT IN ('completed', 'cancelled')").all() as Array<{ data: string }>).map(row => JSON.parse(row.data));
  }

  state(scopeId: string, workflowId?: string): WorkflowState | undefined {
    const row = (workflowId
      ? this.db.prepare('SELECT data FROM workflows WHERE id = ?').get(workflowId)
      : this.db.prepare("SELECT data FROM workflows WHERE scope = ? AND status NOT IN ('completed', 'cancelled')").get(scopeId)
    ) as { data: string } | undefined;
    const state = row ? JSON.parse(row.data) as WorkflowState : undefined;
    return state?.root.scopeId === scopeId ? state : undefined;
  }

  /** Any workflow by ID, regardless of scope or status. */
  byId(workflowId: string): WorkflowState | undefined {
    const state = (this.db.prepare('SELECT data FROM workflows WHERE id = ?').get(workflowId) as { data: string } | undefined);
    return state && JSON.parse(state.data) as WorkflowState;
  }

  latest(scopeId: string): WorkflowState | undefined {
    const row = this.db.prepare('SELECT data FROM workflows WHERE scope = ? ORDER BY rowid DESC LIMIT 1')
      .get(scopeId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as WorkflowState : undefined;
  }

  tree(state: WorkflowState): WorkflowState[] {
    return (this.db.prepare('SELECT data FROM workflows WHERE root_id = ?').all(state.parent?.rootWorkflowId ?? state.workflowId) as Array<{data:string}>)
      .map(row => JSON.parse(row.data) as WorkflowState);
  }

  descendants(state: WorkflowState, taskId?: string): WorkflowState[] {
    const all = this.tree(state);
    const selected: WorkflowState[] = [];
    const ids = new Set([state.workflowId]);
    for (const child of all.sort((a,b)=>(a.parent?.depth ?? 0)-(b.parent?.depth ?? 0))) {
      if (child.parent && ids.has(child.parent.workflowId)
        && (child.parent.workflowId !== state.workflowId || !taskId || child.parent.taskId === taskId)) {
        selected.push(child); ids.add(child.workflowId);
      }
    }
    return selected;
  }

  operation(scope: string, id: string): { digest: string; response: string } | undefined {
    return this.db.prepare('SELECT digest, response FROM workflow_operations WHERE scope = ? AND id = ?')
      .get(scope, id) as { digest: string; response: string } | undefined;
  }

  commitOperation(state: WorkflowState, id: string, digest: string, result: () => unknown): unknown {
    return this.db.transaction(() => {
      this.save(state);
      const response = result();
      this.db.prepare('INSERT INTO workflow_operations(scope, id, digest, response) VALUES (?, ?, ?, ?)')
        .run(state.root.scopeId, id, digest, JSON.stringify(response));
      return response;
    })();
  }

  save(state: WorkflowState): void {
    settleEventWaits(state, this.now());
    state.stateVersion++;
    this.db.prepare('INSERT INTO workflows(id, scope, status, data, root_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data, root_id=excluded.root_id')
      .run(state.workflowId, state.parent ? `${state.root.scopeId}:child:${state.workflowId}` : state.root.scopeId,
        state.status, JSON.stringify(state), state.parent?.rootWorkflowId ?? state.workflowId);
    this.changes.emit(state.root.scopeId);
  }

  onChange(scopeId: string, listener: () => void): () => void {
    this.changes.on(scopeId, listener);
    return () => { this.changes.off(scopeId, listener); };
  }
}
