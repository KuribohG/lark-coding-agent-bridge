import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkItem, WorkItemState } from './types';

const STATE_VERSION = 2;
const DATABASE_SCHEMA_VERSION = 2;

interface MetadataRow {
  key: string;
  value: string;
}

interface NumberRow {
  key: string;
  value: number;
}

/**
 * Durable work-item state.
 *
 * The service keeps working against a deterministic in-memory snapshot while
 * SQLite commits jobs, cursors, dedupe keys, budgets and the delivery outbox
 * atomically.
 */
export class WorkItemStore {
  data: WorkItemState = emptyState();
  private persisted = '';
  private persistedJobs = new Map<string, string>();

  constructor(readonly path: string) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = this.open();
    try {
      this.createSchema(db);
      const initialized = db.prepare(
        "SELECT 1 FROM metadata WHERE key = 'schema_version'",
      ).get();
      this.data = this.read(db);
      this.persistedJobs = new Map(
        this.data.jobs.map((job, index) => [job.id, persistedJob(index, job)]),
      );
      this.persisted = initialized ? JSON.stringify(this.data) : '';
      this.repairInterruptedJobs();
      await this.save();
    } finally {
      db.close();
    }
  }

  async save(): Promise<void> {
    const encoded = JSON.stringify(this.data);
    if (encoded === this.persisted) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = this.open();
    try {
      this.createSchema(db);
      const nextJobs = new Map(
        this.data.jobs.map((job, index) => [job.id, persistedJob(index, job)]),
      );
      const write = db.transaction(() => {
        const deleteJob = db.prepare('DELETE FROM jobs WHERE id = ?');
        for (const id of this.persistedJobs.keys()) {
          if (!nextJobs.has(id)) deleteJob.run(id);
        }
        const upsertJob = db.prepare(`
          INSERT INTO jobs (id, position, updated_at, payload) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            position = excluded.position,
            updated_at = excluded.updated_at,
            payload = excluded.payload
        `);
        for (const [index, job] of this.data.jobs.entries()) {
          const state = nextJobs.get(job.id)!;
          if (this.persistedJobs.get(job.id) === state) continue;
          upsertJob.run(job.id, index, job.updatedAt, jobPayload(job));
        }
        replaceScalars(db, 'cursors', this.data.cursors);
        replaceScalars(db, 'seen', this.data.seen);
        replaceUsage(db, 'analysis', this.data.autoUsage);
        replaceUsage(db, 'triage', this.data.triageUsage ?? {});
        replaceUsage(db, 'notification', this.data.notificationUsage ?? {});
        setMeta(db, 'schema_version', String(DATABASE_SCHEMA_VERSION));
        setMeta(db, 'state_version', String(this.data.version));
        setMeta(db, 'document', JSON.stringify({
          ...(this.data.ownerKey !== undefined ? { ownerKey: this.data.ownerKey } : {}),
          ...(this.data.lastDigestAt !== undefined
            ? { lastDigestAt: this.data.lastDigestAt }
            : {}),
          ...(this.data.notificationOutbox !== undefined
            ? { notificationOutbox: this.data.notificationOutbox }
            : {}),
        }));
      });
      write();
      this.persisted = encoded;
      this.persistedJobs = nextJobs;
    } finally {
      db.close();
    }
  }

  private open(): Database.Database {
    const db = new Database(this.path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Some Windows filesystems do not expose POSIX modes.
    }
    return db;
  }

  private createSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_updated_at ON jobs(updated_at DESC);
      CREATE TABLE IF NOT EXISTS cursors (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        kind TEXT NOT NULL,
        day TEXT NOT NULL,
        value INTEGER NOT NULL,
        PRIMARY KEY (kind, day)
      );
    `);
  }

  private read(db: Database.Database): WorkItemState {
    const meta = new Map(
      (db.prepare('SELECT key, value FROM metadata').all() as MetadataRow[])
        .map(row => [row.key, row.value]),
    );
    const schema = meta.get('schema_version') ?? String(DATABASE_SCHEMA_VERSION);
    if (schema !== String(DATABASE_SCHEMA_VERSION)) {
      throw new Error(`unsupported work-item database schema version: ${schema}`);
    }
    const version = Number(meta.get('state_version') ?? STATE_VERSION);
    if (version !== STATE_VERSION) {
      throw new Error(`unsupported work-item database state version: ${version}`);
    }
    const document = parseDocument(meta.get('document'));
    return {
      version: STATE_VERSION,
      ...(document.ownerKey !== undefined ? { ownerKey: document.ownerKey } : {}),
      cursors: readScalars(db, 'cursors'),
      seen: readScalars(db, 'seen'),
      jobs: (db.prepare('SELECT payload FROM jobs ORDER BY position, rowid').all() as {
        payload: string;
      }[]).map(row => JSON.parse(row.payload) as WorkItem),
      autoUsage: readUsage(db, 'analysis'),
      triageUsage: readUsage(db, 'triage'),
      notificationUsage: readUsage(db, 'notification'),
      ...(document.lastDigestAt !== undefined
        ? { lastDigestAt: document.lastDigestAt }
        : {}),
      ...(document.notificationOutbox !== undefined
        ? { notificationOutbox: document.notificationOutbox }
        : {}),
    };
  }

  private repairInterruptedJobs(): void {
    for (const job of this.data.jobs) {
      if (job.state !== 'running') continue;
      job.state = 'failed';
      job.analysisRequested = false;
      job.analysisPaused = true;
      job.restartPending = true;
      job.error = 'Bridge 重启中断了分析，请重新处理';
    }
  }
}

function emptyState(): WorkItemState {
  return {
    version: STATE_VERSION,
    cursors: {},
    seen: {},
    jobs: [],
    autoUsage: {},
  };
}

function jobPayload(job: WorkItem): string {
  return JSON.stringify(job);
}

function persistedJob(position: number, job: WorkItem): string {
  return `${position}\u001f${jobPayload(job)}`;
}

function replaceScalars(
  db: Database.Database,
  table: 'cursors' | 'seen',
  values: Record<string, number>,
): void {
  db.prepare(`DELETE FROM ${table}`).run();
  const insert = db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(values)) insert.run(key, value);
}

function readScalars(
  db: Database.Database,
  table: 'cursors' | 'seen',
): Record<string, number> {
  return Object.fromEntries(
    (db.prepare(`SELECT key, value FROM ${table}`).all() as NumberRow[])
      .map(row => [row.key, Number(row.value)]),
  );
}

function replaceUsage(
  db: Database.Database,
  kind: string,
  values: Record<string, number>,
): void {
  db.prepare('DELETE FROM usage WHERE kind = ?').run(kind);
  const insert = db.prepare(
    'INSERT INTO usage (kind, day, value) VALUES (?, ?, ?)',
  );
  for (const [day, value] of Object.entries(values)) insert.run(kind, day, value);
}

function readUsage(db: Database.Database, kind: string): Record<string, number> {
  return Object.fromEntries(
    (db.prepare('SELECT day, value FROM usage WHERE kind = ?').all(kind) as {
      day: string;
      value: number;
    }[]).map(row => [row.day, Number(row.value)]),
  );
}

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

interface PersistedDocument {
  ownerKey?: string;
  lastDigestAt?: number;
  notificationOutbox?: WorkItemState['notificationOutbox'];
}

function parseDocument(value: string | undefined): PersistedDocument {
  if (!value) return {};
  const parsed = JSON.parse(value) as PersistedDocument;
  return parsed && typeof parsed === 'object' ? parsed : {};
}
