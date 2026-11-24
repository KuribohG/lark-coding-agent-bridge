import { timingSafeEqual } from 'node:crypto';
import { WorkflowJournalError } from '../engine/kernel-store';
import { WorkflowJournal, type CatalogRow } from './journal';
import { board, member, members, overview, plan, summarize, turn, turns, work, workItem, type ViewSource, type WorkflowSummary } from './views';

/** One workflow store a dashboard reads: a name people recognise and the file. */
export interface DashboardSource {
  name: string;
  path: string;
}

/** A row of the list for a workflow whose state this build cannot read. */
export interface UnreadableWorkflow {
  id: string;
  rootId: string;
  parentId?: string;
  scope: string;
  status: string;
  updatedAt: number;
  unreadable: string;
}

export interface DashboardResponse {
  status: number;
  /** Absent with 304. */
  body?: unknown;
  /** Identifies the content: the same request with this value in `ifNoneMatch` is answered 304 while nothing changed. */
  etag?: string;
}

class NotFound extends Error {}

const number = (value: string | null): number | undefined => {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The read-only JSON API of a workflow dashboard, apart from any transport: a host serves it over HTTP (see
 * startDashboard), mounts it under routes of its own, or calls it in process. Every answer is a projection from
 * views.ts of what the journal holds; nothing here can change a workflow.
 */
export class DashboardApi {
  private readonly journals = new Map<string, WorkflowJournal>();
  private readonly failed = new Map<string, string>();
  /** Summaries of workflows that can no longer change, by the time their catalog row was last written. */
  private readonly finished = new Map<string, { updatedAt: number; summary: WorkflowSummary | UnreadableWorkflow }>();

  constructor(private readonly sources: readonly DashboardSource[], private readonly now: () => number = Date.now) {
    if (new Set(sources.map(source => source.name)).size !== sources.length) throw new Error('Dashboard sources need distinct names');
  }

  /** Opened on first use and again after a failure: the file may not exist until its host has run a workflow. */
  private journal(name: string): WorkflowJournal {
    const known = this.journals.get(name);
    if (known) return known;
    const source = this.sources.find(found => found.name === name);
    if (!source) throw new NotFound(`No such source: ${name}`);
    try {
      const journal = new WorkflowJournal(source.path);
      this.journals.set(name, journal);
      this.failed.delete(name);
      return journal;
    } catch (error) {
      this.failed.set(name, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  close(): void {
    for (const journal of this.journals.values()) journal.close();
    this.journals.clear();
  }

  handle(path: string, query: URLSearchParams = new URLSearchParams(), ifNoneMatch?: string): DashboardResponse {
    try {
      const answer = this.route(path.split('/').filter(Boolean).map(decodeURIComponent), query);
      if (answer.etag && ifNoneMatch === answer.etag) return { status: 304, etag: answer.etag };
      return { status: 200, body: answer.body(), ...(answer.etag ? { etag: answer.etag } : {}) };
    } catch (error) {
      if (error instanceof NotFound) return { status: 404, body: { error: error.message } };
      if (error instanceof WorkflowJournalError) return { status: 409, body: { error: error.message, unreadable: true } };
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  private route(parts: string[], query: URLSearchParams): { etag?: string; body(): unknown } {
    const [head, name, kind, id, view] = parts;
    if (head === 'sources' && parts.length === 1) return { body: () => this.listSources() };
    if (head !== 's' || !name) throw new NotFound('Unknown dashboard path');
    const journal = this.journal(name);
    if (kind === 'workflows' && parts.length === 3) {
      const limit = Math.min(500, Math.max(0, number(query.get('finished')) ?? 50));
      return { etag: `W/"${name}:list:${journal.position()}:${limit}"`, body: () => this.list(journal, limit) };
    }
    if (kind !== 'w' || !id || !view || parts.length !== 5) throw new NotFound('Unknown dashboard path');
    const read = journal.state(id);
    if (!read) throw new NotFound(`No such workflow: ${id}`);
    const source: ViewSource = { state: read.state, archive: journal.archive(id), text: digest => journal.text(digest) };
    const text = (key: string) => query.get(key) || undefined;
    const found = <T>(value: T | undefined, what: string): T => { if (value === undefined) throw new NotFound(`No such ${what}`); return value; };
    const body = ((): (() => unknown) => {
      switch (view) {
        case 'overview': return () => ({ ...overview(read.state, this.now()), tree: journal.tree(read.state.parent?.rootWorkflowId ?? id) });
        case 'members': return () => members(read.state);
        case 'member': return () => found(member(source, query.get('name') ?? ''), 'member');
        case 'work': return () => work(source, { queue: text('queue'), status: text('status'), query: text('q'), offset: number(query.get('offset')),
          limit: number(query.get('limit')), archived: query.get('archived') === '1' });
        case 'item': return () => found(workItem(source, query.get('key') ?? ''), 'work item');
        case 'board': return () => board(source, { topic: text('topic'), member: text('member'), query: text('q'), before: number(query.get('before')), limit: number(query.get('limit')) });
        case 'turns': return () => turns(read.state, { show: text('show'), member: text('member'), offset: number(query.get('offset')), limit: number(query.get('limit')) });
        case 'turn': return () => found(turn(source, query.get('task') ?? ''), 'turn');
        case 'plan': return () => found(plan(source), 'script');
        case 'journal': return () => ({ entries: journal.recent(id, Math.min(500, Math.max(1, number(query.get('limit')) ?? 200)), number(query.get('before'))) });
        default: throw new NotFound('Unknown workflow view');
      }
    })();
    // Lease renewals are not in the journal, so a claim's lease may be shown as it was at the last change.
    return { etag: `W/"${name}:${id}:${read.seq}:${view}?${query}"`, body };
  }

  private listSources(): unknown {
    return { sources: this.sources.map(source => {
      try {
        const journal = this.journal(source.name);
        return { name: source.name, path: source.path, position: journal.position() };
      } catch { return { name: source.name, path: source.path, error: this.failed.get(source.name) }; }
    }) };
  }

  private summary(journal: WorkflowJournal, row: CatalogRow): WorkflowSummary | UnreadableWorkflow {
    try {
      const read = journal.state(row.id);
      if (read) return summarize(read.state, this.now());
      return { ...row, unreadable: 'The catalog lists this workflow but its journal has no entries' };
    } catch (error) {
      return { ...row, unreadable: error instanceof Error ? error.message : String(error) };
    }
  }

  private list(journal: WorkflowJournal, finished: number): unknown {
    const catalog = journal.catalog(finished);
    const workflows = catalog.rows.map(row => {
      if (row.status !== 'completed' && row.status !== 'cancelled') return { ...this.summary(journal, row), updatedAt: row.updatedAt };
      const key = journal.path + '\n' + row.id;
      let known = this.finished.get(key);
      if (known?.updatedAt !== row.updatedAt) this.finished.set(key, known = { updatedAt: row.updatedAt, summary: this.summary(journal, row) });
      return { ...known.summary, updatedAt: row.updatedAt };
    });
    return { position: journal.position(), finished: catalog.finished, workflows };
  }
}

/** Constant-time comparison of a presented token. */
export function sameToken(presented: string, token: string): boolean {
  const a = Buffer.from(presented), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
