import { createHash } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObservationJournal, WorkItemEvent } from '../../../work-items/events';
import { GitLabError, type FailedJob, type Pipeline } from './client';
import type { GitLabCiConfig, GitLabRepository } from './config';

/** A failed pipeline, published as the data of one work item. */
export interface CiRun {
  id: string; repository: GitLabRepository; pipeline: Pipeline; failures: FailedJob[];
  url: string; executorProfile: string; createdAt: number;
}
/** Read positions per repository, committed with the failures each poll found. */
export interface CiState {
  version: 1;
  repositories: Record<string, { since: number; cursor: number }>;
}
interface LegacyCiState extends CiState { runs?: (CiRun & { inboxJobId?: string })[] }
export interface CiIO {
  pipelines(project: string, since: number, until: number, signal: AbortSignal): Promise<Pipeline[]>;
  failures(project: string, id: number, signal: AbortSignal): Promise<FailedJob[]>;
}

export function failureId(url: string, project: string, pipeline: number, failures: FailedJob[]): string {
  return createHash('sha256').update(JSON.stringify([url, project, pipeline,
    failures.map(j => `${j.kind}:${j.id}`).sort()])).digest('hex').slice(0, 32);
}

export function ciTaskEvent(run: CiRun, config: GitLabCiConfig): WorkItemEvent {
  if (!/^[a-f0-9]{32}$/.test(run.id)) throw new Error('Invalid CI failure ID');
  let url = '';
  try { const parsed = new URL(run.pipeline.web_url); if (parsed.origin === new URL(config.url).origin && !parsed.username && !parsed.password) url = parsed.href; } catch { /* optional source link */ }
  return { key: run.id, title: `${run.repository.project} · CI #${run.pipeline.id}`,
    reason: `GitLab CI 失败 · ${run.pipeline.ref} · ${run.pipeline.sha.slice(0, 12)}`, url, time: run.createdAt,
    data: run, evidenceDir: join(config.outputDir, run.id), maxAttempts: 3 };
}

/**
 * Polls failed pipelines. A repository's cursor advances only in the same commit as the
 * failures found up to it; a failed commit leaves both for the next poll, and the
 * work-item engine deduplicates by failure ID across the polls' overlap.
 */
export class GitLabCiService {
  state: CiState = { version: 1, repositories: {} };
  lastError?: string;
  private abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  /** @param legacyPath state file of builds that queued submissions outside the work-item store */
  constructor(readonly config: GitLabCiConfig, private io: CiIO, private journal: ObservationJournal<CiState>,
    private now = Date.now, private legacyPath?: string) {}

  async start(schedule = true): Promise<void> {
    const saved = this.journal.state();
    const legacy = saved ? undefined : await this.readLegacy();
    if (saved && (saved.version !== 1 || !saved.repositories)) throw new Error('Invalid GitLab CI state');
    this.state = saved ?? { version: 1, repositories: legacy?.repositories ?? {} };
    // Persist the baseline before the first request, including when GitLab is unavailable.
    for (const repo of this.config.repositories) {
      this.state.repositories[this.repoKey(repo)] ??= { since: this.now(), cursor: this.now() };
    }
    const pending = (legacy?.runs ?? []).filter(run => !run.inboxJobId && this.belongs(run))
      .map(({ id, repository, pipeline, failures, url, executorProfile, createdAt }) =>
        ciTaskEvent({ id, repository, pipeline, failures, url, executorProfile, createdAt }, this.config));
    await this.journal.commit(pending, this.state);
    if (legacy) await rename(this.legacyPath!, `${this.legacyPath}.migrated`);
    if (schedule) {
      this.timer = setInterval(() => { void this.tick(); }, this.config.pollSeconds * 1000);
      this.timer.unref();
      void this.tick();
    }
  }
  private async readLegacy(): Promise<LegacyCiState | undefined> {
    if (!this.legacyPath) return undefined;
    try {
      const data = JSON.parse(await readFile(this.legacyPath, 'utf8')) as LegacyCiState;
      if (data.version !== 1 || !data.repositories || !Array.isArray(data.runs)) throw new Error('Invalid GitLab CI state');
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private repoKey(repo: GitLabRepository) { return JSON.stringify([this.config.url, this.config.executorProfile, repo.project]); }
  private belongs(run: CiRun): boolean {
    return run.url === this.config.url && run.executorProfile === this.config.executorProfile &&
      this.config.repositories.some(repo => repo.project === run.repository.project && (!repo.refs.length || repo.refs.includes(run.pipeline.ref)));
  }
  tick(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    return this.polling ??= this.poll().catch(error => {
      if (!this.abort.signal.aborted) this.lastError = error instanceof GitLabError ? error.message : 'GitLab CI polling failed';
    }).finally(() => { this.polling = undefined; });
  }
  private async poll(): Promise<void> {
    let failed = false;
    for (const repo of this.config.repositories) {
      this.abort.signal.throwIfAborted();
      const key = this.repoKey(repo);
      const cursor = this.state.repositories[key]!;
      const until = this.now();
      try {
        const pipelines = await this.io.pipelines(repo.project, Math.max(cursor.since, cursor.cursor - 120_000), until, this.abort.signal);
        const events: WorkItemEvent[] = [];
        for (const pipeline of pipelines) {
          if (pipeline.status !== 'failed' || !Number.isSafeInteger(pipeline.id) ||
            (repo.refs.length && !repo.refs.includes(pipeline.ref))) continue;
          const failures = await this.io.failures(repo.project, pipeline.id, this.abort.signal);
          const id = failureId(this.config.url, repo.project, pipeline.id, failures);
          events.push(ciTaskEvent({ id, repository: repo, pipeline, failures, url: this.config.url,
            executorProfile: this.config.executorProfile, createdAt: this.now() }, this.config));
        }
        const next: CiState = { ...this.state, repositories: { ...this.state.repositories, [key]: { ...cursor, cursor: until } } };
        this.abort.signal.throwIfAborted();
        await this.journal.commit(events, next);
        this.state = next;
      } catch (error) {
        this.abort.signal.throwIfAborted();
        failed = true;
        this.lastError = error instanceof GitLabError ? error.message : 'GitLab CI polling failed';
      }
    }
    if (!failed) this.lastError = undefined;
  }
  async idle(): Promise<void> { await this.polling; }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.idle();
  }
}
