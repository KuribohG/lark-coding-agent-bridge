import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { workflowDigest } from './digest';
import { eventEntity, eventTopics, type DomainEvent } from './events';
import { evolve } from './evolve';
import { RECORDS, type RecordKind } from './records';
import type { ArtifactView, StoredArtifact, StoredTask, TaskView, TextRef, WorkflowData, WorkflowState, WorkflowView } from './types';
import { checkpointInBackground } from './wal-checkpointer';

const TERMINAL = new Set<string>(['completed', 'cancelled']);
const SNAPSHOT_EVERY = 2000;
const RETAIN_FINISHED = 64;
const TEXT_CACHE_CHARS = 16_000_000;

interface Aggregate {
  readonly store: WorkflowStore;
  readonly state: WorkflowData;
  /** Journal position of the last event applied. */
  seq: number;
  sinceSnapshot: number;
  /** Status in the catalog row; undefined until the workflow is first persisted. */
  cataloged?: string;
  /** Set when the store dropped this object (a failed transaction, or eviction once finished); the next read loads a new one. */
  stale: boolean;
}

/** Rows for the archive tables, staged while their events are applied and written with them. */
interface ArchiveRows {
  tasks: Array<{ workflowId: string; task: StoredTask; data: string }>;
  artifacts: Array<{ workflowId: string; artifact: StoredArtifact }>;
  calls: Array<{ workflowId: string; runId: string; key: string; taskId: string; agentId?: string }>;
  records: Array<{ workflowId: string; kind: RecordKind; id: string; key?: string; num?: number; data: string }>;
}

/**
 * Finished tasks that have left a workflow's state, read back by the few paths that still need one: a replayed
 * script call looking for its earlier answer, a script reading a result or an artifact by reference, key reuse checks.
 */
export interface WorkflowArchive {
  task(taskId: string): TaskView | undefined;
  /** The successful task of an agent call with this cache key. */
  result(cacheKey: string): TaskView | undefined;
  /** A member's completed turn for this request. */
  turn(agentId: string, requestDigest: string): TaskView | undefined;
  hasKey(scriptKey: string): boolean;
  artifact(ref: string): ArtifactView | undefined;
  /** A call of the given script run. */
  call(runId: string, by: { key: string } | { taskId: string }): { key: string; taskId: string } | undefined;
  /** The task of the member's latest archived call in the given script run. */
  lastTurn(runId: string, agentId: string): string | undefined;
  /** An archived entry of another list (see records.ts) by its ID or key. */
  record(kind: RecordKind, by: { id: string } | { key: string }): unknown;
  /** Archived entries in the order of their position, `after < num <= upTo`; `desc` starts from the end. */
  range(kind: RecordKind, range: { after: number; upTo: number; limit: number; desc?: boolean }): unknown[];
  /** Archived entries whose stored JSON contains every one of `contains` (lower-case), most recently archived first. */
  search(kind: RecordKind, contains: readonly string[], limit: number): unknown[];
}

interface PendingEvent { aggregate: Aggregate; type: string; entity?: string; data: string; topics: string[] }

interface Transaction {
  cause: string;
  events: PendingEvent[];
  touched: Set<Aggregate>;
  versioned: Set<Aggregate>;
  created: Set<Aggregate>;
  texts: Map<string, string>;
  archive: ArchiveRows;
  operations: Array<{ scope: string; id: string; digest: string; response: string }>;
  /** A reducer failed part-way through an event; the transaction cannot commit even if the caller swallowed the error. */
  failed?: { error: unknown };
}

const owners = new WeakMap<object, Aggregate>();

function last<T>(items: T[] | undefined, test: (item: T) => boolean): T | undefined {
  for (let index = (items?.length ?? 0) - 1; index >= 0; index--) if (test(items![index]!)) return items![index];
  return undefined;
}

function owner(state: WorkflowView): Aggregate {
  const aggregate = owners.get(state);
  if (!aggregate) throw new Error('Not a live workflow state');
  return aggregate;
}

/** Records an event against a live workflow and applies it. Only valid inside WorkflowStore.transact. */
export function emit(state: WorkflowView, event: DomainEvent): void {
  const aggregate = owner(state);
  aggregate.store.append(aggregate, event);
}

/** Stores a text out of line as part of the current transaction. */
export function putText(state: WorkflowView, text: string): TextRef {
  return owner(state).store.putText(text);
}

export function readText(state: WorkflowView, ref: { digest: string }): string {
  return owner(state).store.text(ref.digest);
}

/** The workflow's archive, or undefined while nothing of it has been archived. */
export function archiveOf(state: WorkflowView): WorkflowArchive | undefined {
  return state.archived ? owner(state).store.archive(state.workflowId) : undefined;
}

/** The archive of the workflow's other lists; callers check `state.archivedRecords` for the kind first. */
export function recordsOf(state: WorkflowView): WorkflowArchive {
  return owner(state).store.archive(state.workflowId);
}

export interface WorkflowStoreOptions {
  /** Runs for every workflow a transaction changed, before it commits; may emit further events. */
  policy?(state: WorkflowView): void;
  /**
   * Receives what a change listener threw. The commit it was told about stands, so the failure is not the
   * committer's; without a handler the first one is rethrown from transact() after every listener has run.
   */
  listenerFailed?(error: unknown): void;
  /** Open without creating tables or writing snapshots. */
  readonly?: boolean;
  /** Fewest events between two snapshots of a workflow (see snapshotDue). Default 2000. */
  snapshotEvery?: number;
  /** Finished workflows kept in memory for status and artifact reads. Default 64. */
  retainFinished?: number;
  /** Checkpoint the WAL on a background thread instead of inside commits; for a long-lived store on a file. */
  backgroundCheckpoint?: boolean;
  /** Receives the reason background checkpointing could not run; the store then checkpoints inside commits. */
  checkpointFailed?(error: unknown): void;
}

/**
 * Event-sourced persistence for workflows. The journal (wf_events) is the only source of truth; each workflow's
 * state lives in memory and is rebuilt from its latest snapshot plus the events after it. Every change is an event
 * recorded through emit() inside transact(), which commits the events of one operation atomically together with
 * its idempotency record, large texts and catalog row. Finished tasks leave the state through an event as well; the
 * archive tables that then hold them are derived from the journal and keep the state's size independent of how
 * many tasks a workflow has run.
 *
 * One process owns the database (the bridge holds the profile's runtime lock), so the in-memory state is authoritative.
 */
export class WorkflowStore {
  readonly db: Database.Database;
  /** Test and diagnostics hook: runs inside the SQLite transaction after everything is written, before COMMIT. */
  beforeCommit?: (events: ReadonlyArray<{ workflowId: string; type: string }>) => void;
  private readonly changes = new Map<string, Set<() => void>>();
  private readonly watchers = new Map<string, Map<string, Set<() => void>>>();
  private readonly commits = new Set<() => void>();
  private readonly aggregates = new Map<string, Aggregate>();
  /** Workflows that are not completed or cancelled. */
  private readonly open = new Set<string>();
  private readonly roots = new Map<string, string>();
  private readonly trees = new Map<string, string[]>();
  private readonly cold = new Set<string>();
  private readonly texts = new Map<string, string>();
  private textChars = 0;
  private tx?: Transaction;
  private readonly verify = process.env.WORKFLOW_ENGINE_VERIFY === '1';
  private readonly snapshotEvery: number;
  private readonly retainFinished: number;
  private stopCheckpoints?: () => void;

  constructor(path: string, private readonly now: () => number, private readonly options: WorkflowStoreOptions = {}) {
    this.snapshotEvery = options.snapshotEvery ?? SNAPSHOT_EVERY;
    this.retainFinished = options.retainFinished ?? RETAIN_FINISHED;
    if (path !== ':memory:' && !options.readonly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, options.readonly ? { readonly: true, fileMustExist: true } : {});
    if (!options.readonly) {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.pragma('journal_mode = WAL');
      // The wf_ tables are new in the event-sourced store. A `workflows` table from earlier versions is left untouched.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS wf_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, root_id TEXT NOT NULL,
          version INTEGER NOT NULL, type TEXT NOT NULL, entity TEXT, at INTEGER NOT NULL, cause TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS wf_events_stream ON wf_events(workflow_id, seq);
        CREATE INDEX IF NOT EXISTS wf_events_root ON wf_events(root_id, seq);
        CREATE INDEX IF NOT EXISTS wf_events_entity ON wf_events(workflow_id, entity, seq) WHERE entity IS NOT NULL;
        CREATE TABLE IF NOT EXISTS wf_texts (digest TEXT PRIMARY KEY, text TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wf_snapshots (workflow_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wf_catalog (id TEXT PRIMARY KEY, scope TEXT NOT NULL, root_id TEXT NOT NULL, parent_id TEXT, status TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS wf_catalog_binding ON wf_catalog(scope) WHERE parent_id IS NULL AND status NOT IN ('completed', 'cancelled');
        CREATE INDEX IF NOT EXISTS wf_catalog_tree ON wf_catalog(root_id);
        CREATE TABLE IF NOT EXISTS workflow_operations (scope TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
          response TEXT NOT NULL, PRIMARY KEY(scope, id));
        CREATE TABLE IF NOT EXISTS workflow_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wf_archived_tasks (workflow_id TEXT NOT NULL, task_id TEXT NOT NULL, script_key TEXT, cache_key TEXT,
          agent_id TEXT, request_digest TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workflow_id, task_id));
        CREATE INDEX IF NOT EXISTS wf_archived_tasks_cache ON wf_archived_tasks(workflow_id, cache_key) WHERE cache_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS wf_archived_tasks_key ON wf_archived_tasks(workflow_id, script_key) WHERE script_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS wf_archived_tasks_turn ON wf_archived_tasks(workflow_id, agent_id, request_digest) WHERE agent_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS wf_archived_artifacts (workflow_id TEXT NOT NULL, ref TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workflow_id, ref));
        CREATE TABLE IF NOT EXISTS wf_archived_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, key TEXT NOT NULL,
          run_id TEXT NOT NULL, task_id TEXT NOT NULL, agent_id TEXT, UNIQUE(workflow_id, key));
        CREATE INDEX IF NOT EXISTS wf_archived_calls_task ON wf_archived_calls(workflow_id, task_id);
        CREATE INDEX IF NOT EXISTS wf_archived_calls_member ON wf_archived_calls(workflow_id, agent_id, seq) WHERE agent_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS wf_archive (workflow_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, key TEXT, num INTEGER,
          data TEXT NOT NULL, PRIMARY KEY(workflow_id, kind, id));
        CREATE INDEX IF NOT EXISTS wf_archive_key ON wf_archive(workflow_id, kind, key) WHERE key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS wf_archive_num ON wf_archive(workflow_id, kind, num) WHERE num IS NOT NULL;
      `);
    }
    if (options.backgroundCheckpoint && !options.readonly && path !== ':memory:') {
      this.stopCheckpoints = checkpointInBackground(this.db, path, error => options.checkpointFailed?.(error));
    }
    if (!this.hasTable('wf_catalog')) return;
    for (const row of this.db.prepare("SELECT id, scope, parent_id FROM wf_catalog WHERE status NOT IN ('completed', 'cancelled')")
      .all() as Array<{ id: string; scope: string; parent_id: string | null }>) {
      this.open.add(row.id);
      if (!row.parent_id) this.roots.set(row.scope, row.id);
    }
  }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  /** Unfinished workflows persisted by the pre-event-sourcing store, which this store does not read. */
  legacyUnfinished(): number {
    if (!this.hasTable('workflows')) return 0;
    try {
      return (this.db.prepare("SELECT count(*) AS count FROM workflows WHERE status NOT IN ('completed', 'cancelled')").get() as { count: number }).count;
    } catch { return 0; }
  }

  heartbeat(): number {
    return Number((this.db.prepare("SELECT value FROM workflow_meta WHERE key = 'heartbeat'").get() as { value: string } | undefined)?.value);
  }

  writeHeartbeat(at: number): void {
    this.db.prepare("INSERT INTO workflow_meta(key, value) VALUES ('heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(at));
  }

  // Reads. The returned states are live: they change as events are applied, and must only be changed through emit().

  /** Unfinished workflows. */
  list(): WorkflowView[] {
    return [...this.open].flatMap(id => this.byId(id) ?? []);
  }

  state(scopeId: string, workflowId?: string): WorkflowView | undefined {
    const id = workflowId ?? this.roots.get(scopeId);
    const state = id ? this.byId(id) : undefined;
    return state?.root.scopeId === scopeId ? state : undefined;
  }

  /** Any workflow by ID, regardless of scope or status. */
  byId(workflowId: string): WorkflowView | undefined {
    return this.aggregate(workflowId)?.state;
  }

  /** The most recently started root workflow of a scope, finished or not. */
  latest(scopeId: string): WorkflowView | undefined {
    const row = this.db.prepare('SELECT id FROM wf_catalog WHERE scope = ? AND parent_id IS NULL ORDER BY rowid DESC LIMIT 1')
      .get(scopeId) as { id: string } | undefined;
    return row && this.byId(row.id);
  }

  /** Every workflow under the same root, the root included, oldest first. */
  tree(state: WorkflowView): WorkflowView[] {
    const rootId = state.parent?.rootWorkflowId ?? state.workflowId;
    let ids = this.trees.get(rootId);
    if (!ids) {
      ids = (this.db.prepare('SELECT id FROM wf_catalog WHERE root_id = ? ORDER BY rowid').all(rootId) as Array<{ id: string }>).map(row => row.id);
      // Workflows created by the open transaction are not in the catalog yet.
      for (const created of this.tx?.created ?? []) {
        const data = created.state;
        if ((data.parent?.rootWorkflowId ?? data.workflowId) === rootId && !ids.includes(data.workflowId)) ids.push(data.workflowId);
      }
      this.trees.set(rootId, ids);
    }
    return ids.flatMap(id => this.byId(id) ?? []);
  }

  descendants(state: WorkflowView, taskId?: string): WorkflowView[] {
    const selected: WorkflowView[] = [];
    const ids = new Set([state.workflowId]);
    for (const child of this.tree(state).sort((a, b) => (a.parent?.depth ?? 0) - (b.parent?.depth ?? 0))) {
      if (child.parent && ids.has(child.parent.workflowId)
        && (child.parent.workflowId !== state.workflowId || !taskId || child.parent.taskId === taskId)) {
        selected.push(child); ids.add(child.workflowId);
      }
    }
    return selected;
  }

  /** A detached copy in the public shape: safe to keep, mutate or serialize; texts load when first read. */
  public(state: WorkflowView): WorkflowState {
    const copy = JSON.parse(JSON.stringify(state)) as WorkflowData;
    for (const artifact of copy.artifacts) this.lazyText(artifact, 'text', artifact.digest);
    for (const task of copy.tasks) this.lazyText(task, 'objective', task.objective.digest);
    return copy as unknown as WorkflowState;
  }

  private lazyText(target: object, key: string, digest: string): void {
    Object.defineProperty(target, key, { enumerable: true, configurable: true,
      get: () => {
        const value = this.text(digest);
        Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
        return value;
      } });
  }

  text(digest: string): string {
    const pending = this.tx?.texts.get(digest) ?? this.texts.get(digest);
    if (pending !== undefined) return pending;
    const row = this.db.prepare('SELECT text FROM wf_texts WHERE digest = ?').get(digest) as { text: string } | undefined;
    if (!row) throw new Error('Stored text not found');
    this.cacheText(digest, row.text);
    return row.text;
  }

  putText(text: string): TextRef {
    const digest = workflowDigest(text);
    this.transaction().texts.set(digest, text);
    this.cacheText(digest, text);
    return { digest, chars: text.length };
  }

  private cacheText(digest: string, text: string): void {
    if (this.texts.has(digest)) return;
    this.texts.set(digest, text);
    this.textChars += text.length;
    for (const [oldest, value] of this.texts) {
      if (this.textChars <= TEXT_CACHE_CHARS || oldest === digest) break;
      this.texts.delete(oldest); this.textChars -= value.length;
    }
  }

  /**
   * Reads of one workflow's archive. The archive tables are a projection of the `tasks_archived` and
   * `script_call_archived` events, written in the commit that records them; rows staged by the open transaction
   * are visible to it.
   */
  archive(workflowId: string): WorkflowArchive {
    const staged = () => this.tx?.archive;
    const task = (where: string, values: string[], pending: (task: StoredTask) => boolean): StoredTask | undefined => {
      const found = last(staged()?.tasks, row => row.workflowId === workflowId && pending(row.task));
      if (found) return found.task;
      const row = this.db.prepare(`SELECT data FROM wf_archived_tasks WHERE workflow_id = ? AND ${where} ORDER BY rowid DESC LIMIT 1`)
        .get(workflowId, ...values) as { data: string } | undefined;
      return row && JSON.parse(row.data) as StoredTask;
    };
    return {
      task: taskId => task('task_id = ?', [taskId], found => found.taskId === taskId),
      result: cacheKey => task("cache_key = ? AND status = 'result_ready'", [cacheKey], found => found.cacheKey === cacheKey && found.status === 'result_ready'),
      turn: (agentId, requestDigest) => task('agent_id = ? AND request_digest = ?', [agentId, requestDigest],
        found => found.agentId === agentId && found.requestDigest === requestDigest),
      hasKey: scriptKey => Boolean(task('script_key = ?', [scriptKey], found => found.scriptKey === scriptKey)),
      artifact: ref => {
        const found = staged()?.artifacts.find(row => row.workflowId === workflowId && row.artifact.ref === ref);
        if (found) return found.artifact;
        const row = this.db.prepare('SELECT data FROM wf_archived_artifacts WHERE workflow_id = ? AND ref = ?').get(workflowId, ref) as { data: string } | undefined;
        return row && JSON.parse(row.data) as StoredArtifact;
      },
      call: (runId, by) => {
        const wanted = 'key' in by ? by.key : by.taskId;
        const found = last(staged()?.calls, row => row.workflowId === workflowId && row.runId === runId && ('key' in by ? row.key : row.taskId) === wanted);
        if (found) return { key: found.key, taskId: found.taskId };
        // A staged row for the same key replaces the stored one when the transaction commits.
        const row = this.db.prepare(`SELECT key, task_id FROM wf_archived_calls WHERE workflow_id = ? AND run_id = ? AND ${'key' in by ? 'key' : 'task_id'} = ? ORDER BY seq DESC LIMIT 1`)
          .get(workflowId, runId, wanted) as { key: string; task_id: string } | undefined;
        return row && !staged()?.calls.some(pending => pending.workflowId === workflowId && pending.key === row.key) ? { key: row.key, taskId: row.task_id } : undefined;
      },
      lastTurn: (runId, agentId) => {
        const found = last(staged()?.calls, row => row.workflowId === workflowId && row.runId === runId && row.agentId === agentId);
        if (found) return found.taskId;
        return (this.db.prepare('SELECT task_id FROM wf_archived_calls WHERE workflow_id = ? AND agent_id = ? AND run_id = ? ORDER BY seq DESC LIMIT 1')
          .get(workflowId, agentId, runId) as { task_id: string } | undefined)?.task_id;
      },
      record: (kind, by) => {
        const found = last(staged()?.records, row => row.workflowId === workflowId && row.kind === kind && ('id' in by ? row.id === by.id : row.key === by.key));
        if (found) return JSON.parse(found.data);
        const row = this.db.prepare(`SELECT data FROM wf_archive WHERE workflow_id = ? AND kind = ? AND ${'id' in by ? 'id' : 'key'} = ? ORDER BY rowid DESC LIMIT 1`)
          .get(workflowId, kind, 'id' in by ? by.id : by.key) as { data: string } | undefined;
        return row && JSON.parse(row.data);
      },
      range: (kind, { after, upTo, limit, desc }) => {
        const pending = (staged()?.records ?? []).filter(row => row.workflowId === workflowId && row.kind === kind && row.num !== undefined && row.num > after && row.num <= upTo);
        const rows = this.db.prepare(`SELECT num, data FROM wf_archive WHERE workflow_id = ? AND kind = ? AND num > ? AND num <= ? ORDER BY num ${desc ? 'DESC' : 'ASC'} LIMIT ?`)
          .all(workflowId, kind, after, upTo, limit) as Array<{ num: number; data: string }>;
        const all = [...rows, ...pending.map(row => ({ num: row.num!, data: row.data }))].sort((a, b) => desc ? b.num - a.num : a.num - b.num);
        return all.slice(0, limit).map(row => JSON.parse(row.data));
      },
      search: (kind, contains, limit) => {
        const pending = (staged()?.records ?? []).filter(row => row.workflowId === workflowId && row.kind === kind
          && contains.every(term => row.data.toLowerCase().includes(term))).reverse();
        const rows = this.db.prepare(`SELECT data FROM wf_archive WHERE workflow_id = ? AND kind = ?${' AND instr(lower(data), ?) > 0'.repeat(contains.length)} ORDER BY rowid DESC LIMIT ?`)
          .all(workflowId, kind, ...contains, limit) as Array<{ data: string }>;
        return [...pending, ...rows].slice(0, limit).map(row => JSON.parse(row.data));
      },
    };
  }

  /** Copies what an archive event is about to remove from the state, so the commit can write it to the archive tables. */
  private stage(rows: ArchiveRows, state: WorkflowData, event: Extract<DomainEvent, { type: 'tasks_archived' | 'script_call_archived' | 'records_archived' }>): void {
    const { workflowId } = state;
    if (event.type === 'records_archived') {
      const spec = RECORDS[event.kind];
      const wanted = new Set(event.ids);
      for (const entry of spec.list(state) ?? []) {
        const id = spec.id(entry, state);
        if (wanted.has(id)) rows.records.push({ workflowId, kind: event.kind, id, key: spec.key?.(entry), num: spec.num?.(entry), data: JSON.stringify(entry) });
      }
      return;
    }
    if (event.type === 'script_call_archived') {
      rows.calls.push({ workflowId, runId: state.script!.runId, ...event.call });
      return;
    }
    const tasks = new Map<string, StoredTask>();
    const wanted = new Set(event.taskIds);
    for (const task of state.tasks) {
      if (!wanted.has(task.taskId)) continue;
      const data = JSON.stringify(task);
      const copy = JSON.parse(data) as StoredTask;
      tasks.set(task.taskId, copy);
      rows.tasks.push({ workflowId, task: copy, data });
    }
    const refs = new Set(event.artifactRefs);
    for (const artifact of state.artifacts) if (refs.has(artifact.ref)) rows.artifacts.push({ workflowId, artifact: { ...artifact } });
    for (const call of state.script?.calls ?? []) {
      const task = tasks.get(call.taskId);
      if (task) rows.calls.push({ workflowId, runId: state.script!.runId, key: call.key, taskId: call.taskId, ...(task.agentId ? { agentId: task.agentId } : {}) });
    }
  }

  operation(scope: string, id: string): { digest: string; response: string } | undefined {
    return this.db.prepare('SELECT digest, response FROM workflow_operations WHERE scope = ? AND id = ?')
      .get(scope, id) as { digest: string; response: string } | undefined;
  }

  // Writes

  /**
   * Runs one operation. Events emitted inside commit together when the outermost call returns; if it throws, nothing
   * is written and the workflows it touched are reloaded from the journal on their next read, so callers must not
   * keep using state objects after a failure. Nested calls join the enclosing transaction.
   */
  transact<T>(fn: () => T, cause = 'system'): T {
    if (this.tx) return fn();
    const tx: Transaction = this.tx = { cause, events: [], touched: new Set(), versioned: new Set(), created: new Set(), texts: new Map(), archive: { tasks: [], artifacts: [], calls: [], records: [] }, operations: [] };
    let result: T;
    try {
      result = fn();
      if (tx.failed) throw tx.failed.error;
      this.seal(tx);
      this.persist(tx);
    } catch (error) {
      this.tx = undefined;
      this.discard(tx);
      throw error;
    }
    this.tx = undefined;
    this.settle(tx);
    return result;
  }

  /** Whether a transaction is open; workflow changes outside one are rejected. */
  get transacting(): boolean {
    return Boolean(this.tx);
  }

  private transaction(): Transaction {
    if (!this.tx) throw new Error('Workflow changes require a transaction');
    return this.tx;
  }

  /** Starts a workflow from its initial state. */
  create(initial: WorkflowData): WorkflowView {
    const tx = this.transaction();
    if (!initial.parent && this.roots.has(initial.root.scopeId)) throw new Error('Scope already has an unfinished workflow');
    const data = JSON.stringify({ type: 'workflow_created', state: initial } satisfies DomainEvent);
    const state = (JSON.parse(data) as { state: WorkflowData }).state;
    const aggregate: Aggregate = { store: this, state, seq: 0, sinceSnapshot: 0, stale: false };
    owners.set(state, aggregate);
    this.aggregates.set(state.workflowId, aggregate);
    this.open.add(state.workflowId);
    if (!state.parent) this.roots.set(state.root.scopeId, state.workflowId);
    this.trees.get(state.parent?.rootWorkflowId ?? state.workflowId)?.push(state.workflowId);
    tx.events.push({ aggregate, type: 'workflow_created', data, topics: ['lifecycle'] });
    tx.touched.add(aggregate); tx.created.add(aggregate);
    return state;
  }

  append(aggregate: Aggregate, event: DomainEvent): void {
    const tx = this.transaction();
    if (aggregate.stale) throw new Error('Workflow state is no longer live; read it again');
    // Apply what the journal will hold, so a replay sees exactly the values applied now.
    const data = JSON.stringify(event);
    // Touched before the reducer runs: if it throws half-way, the state is discarded with the transaction.
    tx.touched.add(aggregate);
    if (event.type === 'tasks_archived' || event.type === 'script_call_archived' || event.type === 'records_archived') this.stage(tx.archive, aggregate.state, event);
    try { evolve(aggregate.state, JSON.parse(data) as DomainEvent); }
    catch (error) { tx.failed ??= { error }; throw error; }
    tx.events.push({ aggregate, type: event.type, entity: eventEntity(event), data, topics: eventTopics(event) });
  }

  /**
   * Records the idempotent response of a main-agent operation in the open transaction. The state version is final
   * when `response` runs.
   */
  commitOperation(scope: string, id: string, digest: string, response: () => unknown): unknown {
    const tx = this.transaction();
    this.seal(tx);
    const value = response();
    tx.operations.push({ scope, id, digest, response: JSON.stringify(value) });
    return value;
  }

  /** Runs the policy over changed workflows and gives each one a single new state version for this transaction. */
  private seal(tx: Transaction): void {
    if (this.options.policy) for (const aggregate of [...tx.touched]) this.options.policy(aggregate.state);
    for (const aggregate of tx.touched) {
      if (tx.versioned.has(aggregate)) continue;
      aggregate.state.stateVersion++;
      tx.versioned.add(aggregate);
    }
  }

  private persist(tx: Transaction): void {
    if (!tx.events.length && !tx.operations.length) return;
    const at = this.now();
    this.db.transaction(() => {
      const text = this.db.prepare('INSERT OR IGNORE INTO wf_texts(digest, text) VALUES (?, ?)');
      for (const [digest, value] of tx.texts) text.run(digest, value);
      const event = this.db.prepare('INSERT INTO wf_events(workflow_id, root_id, version, type, entity, at, cause, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const pending of tx.events) {
        const { state } = pending.aggregate;
        const info = event.run(state.workflowId, state.parent?.rootWorkflowId ?? state.workflowId, state.stateVersion,
          pending.type, pending.entity ?? null, at, tx.cause, pending.data);
        pending.aggregate.seq = Number(info.lastInsertRowid);
        pending.aggregate.sinceSnapshot++;
      }
      const { archive } = tx;
      if (archive.tasks.length) {
        const task = this.db.prepare('INSERT OR REPLACE INTO wf_archived_tasks(workflow_id, task_id, script_key, cache_key, agent_id, request_digest, status, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const row of archive.tasks) task.run(row.workflowId, row.task.taskId, row.task.scriptKey ?? null, row.task.cacheKey ?? null, row.task.agentId ?? null,
          row.task.requestDigest, row.task.status, row.data);
      }
      if (archive.artifacts.length) {
        const artifact = this.db.prepare('INSERT OR REPLACE INTO wf_archived_artifacts(workflow_id, ref, data) VALUES (?, ?, ?)');
        for (const row of archive.artifacts) artifact.run(row.workflowId, row.artifact.ref, JSON.stringify(row.artifact));
      }
      if (archive.calls.length) {
        // One row for each key: a later run that makes the call again takes the row over.
        const call = this.db.prepare('INSERT OR REPLACE INTO wf_archived_calls(workflow_id, key, run_id, task_id, agent_id) VALUES (?, ?, ?, ?, ?)');
        for (const row of archive.calls) call.run(row.workflowId, row.key, row.runId, row.taskId, row.agentId ?? null);
      }
      if (archive.records.length) {
        const record = this.db.prepare('INSERT OR REPLACE INTO wf_archive(workflow_id, kind, id, key, num, data) VALUES (?, ?, ?, ?, ?, ?)');
        for (const row of archive.records) record.run(row.workflowId, row.kind, row.id, row.key ?? null, row.num ?? null, row.data);
      }
      const catalog = this.db.prepare('INSERT INTO wf_catalog(id, scope, root_id, parent_id, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status');
      for (const aggregate of tx.touched) {
        const { state } = aggregate;
        if (aggregate.cataloged !== state.status) {
          catalog.run(state.workflowId, state.root.scopeId, state.parent?.rootWorkflowId ?? state.workflowId, state.parent?.workflowId ?? null, state.status);
        }
        if (this.snapshotDue(aggregate) || TERMINAL.has(state.status) && aggregate.sinceSnapshot) this.snapshot(aggregate);
      }
      const operation = this.db.prepare('INSERT INTO workflow_operations(scope, id, digest, response) VALUES (?, ?, ?, ?)');
      for (const item of tx.operations) operation.run(item.scope, item.id, item.digest, item.response);
      this.beforeCommit?.(tx.events.map(pending => ({ workflowId: pending.aggregate.state.workflowId, type: pending.type })));
    })();
  }

  /**
   * Replaying an event costs microseconds while a snapshot rewrites the whole state, so a snapshot waits until the
   * events since the last one outnumber both the configured interval and the entities in the state. That keeps the
   * snapshot work per event constant however large a workflow grows.
   */
  private snapshotDue(aggregate: Aggregate): boolean {
    const { state } = aggregate;
    return aggregate.sinceSnapshot >= this.snapshotEvery
      && aggregate.sinceSnapshot >= state.tasks.length + state.artifacts.length + (state.workQueue?.items.length ?? 0);
  }

  private snapshot(aggregate: Aggregate): void {
    this.db.prepare('INSERT INTO wf_snapshots(workflow_id, seq, data) VALUES (?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET seq = excluded.seq, data = excluded.data')
      .run(aggregate.state.workflowId, aggregate.seq, JSON.stringify(aggregate.state));
    aggregate.sinceSnapshot = 0;
  }

  /** After a successful commit: index bookkeeping, then notifications. */
  private settle(tx: Transaction): void {
    const scopes = new Set<string>();
    for (const aggregate of tx.touched) {
      const { state } = aggregate;
      aggregate.cataloged = state.status;
      scopes.add(state.root.scopeId);
      if (!TERMINAL.has(state.status)) {
        // Normally a no-op; a replaced workflow may have come back from a finished state.
        this.open.add(state.workflowId); this.cold.delete(state.workflowId);
        if (!state.parent) this.roots.set(state.root.scopeId, state.workflowId);
        continue;
      }
      this.open.delete(state.workflowId);
      if (!state.parent && this.roots.get(state.root.scopeId) === state.workflowId) this.roots.delete(state.root.scopeId);
      this.chill(state.workflowId);
    }
    if (this.verify) for (const aggregate of tx.touched) this.check(aggregate);
    if (!tx.events.length) return;
    const listeners = new Set<() => void>();
    for (const pending of tx.events) {
      const topics = this.watchers.get(pending.aggregate.state.workflowId);
      if (topics) for (const topic of pending.topics) for (const listener of topics.get(topic) ?? []) listeners.add(listener);
    }
    // The commit stands whatever a listener does: deliver to all of them, then report the first failure.
    const failures: unknown[] = [];
    const deliver = (listener: () => void) => {
      try { listener(); }
      catch (error) { if (this.options.listenerFailed) this.options.listenerFailed(error); else failures.push(error); }
    };
    for (const listener of listeners) deliver(listener);
    for (const scope of scopes) for (const listener of this.changes.get(scope) ?? []) deliver(listener);
    for (const listener of [...this.commits]) deliver(listener);
    if (failures.length) throw failures[0];
  }

  /** Keeps a bounded number of finished workflows in memory. */
  private chill(workflowId: string): void {
    this.cold.delete(workflowId);
    this.cold.add(workflowId);
    for (const oldest of this.cold) {
      if (this.cold.size <= this.retainFinished) break;
      const aggregate = this.aggregates.get(oldest);
      if (aggregate && this.tx?.touched.has(aggregate)) continue;
      this.cold.delete(oldest);
      if (this.open.has(oldest)) continue;
      // Holders of the evicted object must read the workflow again rather than change a copy nobody else sees.
      if (aggregate) aggregate.stale = true;
      this.aggregates.delete(oldest); this.trees.delete(oldest);
    }
  }

  private discard(tx: Transaction): void {
    for (const aggregate of tx.touched) {
      const { state } = aggregate;
      aggregate.stale = true;
      if (this.aggregates.get(state.workflowId) === aggregate) this.aggregates.delete(state.workflowId);
      if (!tx.created.has(aggregate)) continue;
      this.open.delete(state.workflowId);
      if (!state.parent && this.roots.get(state.root.scopeId) === state.workflowId) this.roots.delete(state.root.scopeId);
      const members = this.trees.get(state.parent?.rootWorkflowId ?? state.workflowId);
      if (members?.includes(state.workflowId)) members.splice(members.indexOf(state.workflowId), 1);
    }
  }

  private aggregate(workflowId: string): Aggregate | undefined {
    let aggregate = this.aggregates.get(workflowId);
    if (!aggregate) {
      const loaded = this.load(workflowId);
      if (!loaded) return undefined;
      aggregate = { store: this, ...loaded, cataloged: loaded.state.status, stale: false };
      owners.set(aggregate.state, aggregate);
      this.aggregates.set(workflowId, aggregate);
    }
    if (TERMINAL.has(aggregate.state.status) && !this.tx?.touched.has(aggregate)) this.chill(workflowId);
    return aggregate;
  }

  /** Rebuilds a workflow from its snapshot and the events after it. */
  private load(workflowId: string, fromStart = false): { state: WorkflowData; seq: number; sinceSnapshot: number } | undefined {
    const snapshot = fromStart ? undefined
      : this.db.prepare('SELECT seq, data FROM wf_snapshots WHERE workflow_id = ?').get(workflowId) as { seq: number; data: string } | undefined;
    let state = snapshot ? JSON.parse(snapshot.data) as WorkflowData : undefined;
    let seq = snapshot?.seq ?? 0;
    const rows = this.db.prepare('SELECT seq, version, data FROM wf_events WHERE workflow_id = ? AND seq > ? ORDER BY seq')
      .all(workflowId, seq) as Array<{ seq: number; version: number; data: string }>;
    for (const row of rows) {
      const event = JSON.parse(row.data) as DomainEvent;
      if (event.type === 'workflow_created') state = event.state;
      else evolve(state!, event);
      state!.stateVersion = row.version;
      seq = row.seq;
    }
    return state && { state, seq, sinceSnapshot: rows.length };
  }

  /** Verification mode: the journal alone, replayed from its first event, must reproduce the in-memory state. */
  private check(aggregate: Aggregate): void {
    const rebuilt = this.load(aggregate.state.workflowId, true)?.state;
    if (workflowDigest(rebuilt) === workflowDigest(aggregate.state)) return;
    const live = aggregate.state as unknown as Record<string, unknown>;
    const keys = Object.keys({ ...rebuilt, ...live }).filter(key => workflowDigest((rebuilt as unknown as Record<string, unknown> | undefined)?.[key]) !== workflowDigest(live[key]));
    aggregate.stale = true;
    if (this.aggregates.get(aggregate.state.workflowId) === aggregate) this.aggregates.delete(aggregate.state.workflowId);
    throw new Error(`Workflow state diverged from its journal in: ${keys.join(', ')}`);
  }

  /** Repair and test tooling: makes a workflow's state exactly `replacement`, creating the workflow if it is unknown. */
  replace(replacement: WorkflowState): void {
    this.transaction();
    const artifacts: StoredArtifact[] = replacement.artifacts.map(({ text, ...artifact }) => ({ ...artifact, ...this.putText(text) }));
    const tasks: StoredTask[] = replacement.tasks.map(task => ({ ...task, objective: this.putText(task.objective) }));
    const state: WorkflowData = { ...replacement, artifacts, tasks };
    const aggregate = this.aggregate(state.workflowId);
    // The commit adds one to the version; start one below so the workflow ends up with the replacement's own.
    const versioned = { ...state, stateVersion: state.stateVersion - 1 };
    if (aggregate) this.append(aggregate, { type: 'workflow_replaced', state: versioned });
    else this.create(versioned);
  }

  // Notifications, delivered after a commit

  /** Any committed change to a workflow of this scope. */
  onChange(scopeId: string, listener: () => void): () => void {
    let listeners = this.changes.get(scopeId);
    if (!listeners) this.changes.set(scopeId, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.changes.get(scopeId) === listeners) this.changes.delete(scopeId);
    };
  }

  /** Committed events of one workflow that touch any of `topics` (see eventTopics). */
  watch(workflowId: string, topics: string[], listener: () => void): () => void {
    const byTopic = this.watchers.get(workflowId) ?? new Map<string, Set<() => void>>();
    this.watchers.set(workflowId, byTopic);
    for (const topic of topics) {
      let listeners = byTopic.get(topic);
      if (!listeners) byTopic.set(topic, listeners = new Set());
      listeners.add(listener);
    }
    return () => {
      for (const topic of topics) {
        const listeners = byTopic.get(topic);
        listeners?.delete(listener);
        if (listeners && !listeners.size) byTopic.delete(topic);
      }
      if (!byTopic.size && this.watchers.get(workflowId) === byTopic) this.watchers.delete(workflowId);
    };
  }

  /** Every commit that recorded events. */
  onCommit(listener: () => void): () => void {
    this.commits.add(listener);
    return () => { this.commits.delete(listener); };
  }

  /** Writes a snapshot of every workflow changed since its last one, so the next start replays little. */
  close(): void {
    if (!this.db.open) return;
    this.stopCheckpoints?.();
    if (!this.options.readonly) {
      this.db.transaction(() => {
        for (const aggregate of this.aggregates.values()) if (aggregate.sinceSnapshot && !aggregate.stale) this.snapshot(aggregate);
      })();
    }
    this.db.close();
  }
}

/** Every workflow in a store file, in the public shape with texts loaded. Opens the file read-only. */
export function readWorkflowStates(path: string): WorkflowState[] {
  const store = new WorkflowStore(path, Date.now, { readonly: true });
  try {
    const exists = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wf_catalog'").get();
    const ids = exists ? (store.db.prepare('SELECT id FROM wf_catalog ORDER BY rowid').all() as Array<{ id: string }>).map(row => row.id) : [];
    return ids.flatMap(id => store.byId(id) ?? []).map(state => JSON.parse(JSON.stringify(store.public(state))) as WorkflowState);
  } finally { store.close(); }
}

/** Repair and test tooling: overwrites (or inserts) one workflow in a store file that no kernel has open. */
export function replaceWorkflowState(path: string, state: WorkflowState): void {
  const store = new WorkflowStore(path, Date.now);
  try { store.transact(() => store.replace(state), 'replace'); }
  finally { store.close(); }
}
