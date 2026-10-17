import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { GitLabError, type FailedJob, type Pipeline } from './client';
import type { GitLabCiConfig, GitLabRepository } from './config';
import type { InboxConfig } from '../inbox/config';

export interface CiRun {
  id: string; repository: GitLabRepository; pipeline: Pipeline; failures: FailedJob[];
  url: string; executorProfile: string;
  createdAt: number; updatedAt: number; attempts: number; retryAt: number;
  state: 'queued' | 'running' | 'ready' | 'done' | 'failed' | 'obsolete';
  resultPath?: string; error?: string;
  topic?: InboxConfig['destination']; deliveryAttempts?: number; deliveredAt?: number;
}
interface CiState {
  version: 1;
  repositories: Record<string, { since: number; cursor: number }>;
  runs: CiRun[];
  lastPollAt?: number; lastError?: string;
}
export interface CiIO {
  pipelines(project: string, since: number, until: number, signal: AbortSignal): Promise<Pipeline[]>;
  failures(project: string, id: number, signal: AbortSignal): Promise<FailedJob[]>;
  analyze(run: CiRun, signal: AbortSignal): Promise<string | undefined>;
  announce?(run: CiRun, signal: AbortSignal): Promise<InboxConfig['destination']>;
  deliver?(run: CiRun, signal: AbortSignal): Promise<void>;
}

export function failureId(url: string, project: string, pipeline: number, failures: FailedJob[]): string {
  return createHash('sha256').update(JSON.stringify([url, project, pipeline,
    failures.map(j => `${j.kind}:${j.id}`).sort()])).digest('hex').slice(0, 32);
}

export class GitLabCiService {
  data: CiState = { version: 1, repositories: {}, runs: [] };
  lastError?: string;
  private abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private worker?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  constructor(readonly path: string, readonly config: GitLabCiConfig, private io: CiIO, private now = Date.now) {}

  async start(schedule = true): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as CiState;
      if (data.version !== 1 || !data.repositories || !Array.isArray(data.runs)) throw new Error('Invalid GitLab CI state');
      this.data = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const run of this.data.runs) if (run.state === 'running') {
      run.state = run.attempts < 3 ? 'queued' : 'failed';
      run.error = 'Bridge interrupted the analysis';
    }
    // Persist the baseline before the first request, including when GitLab is unavailable.
    for (const repo of this.config.repositories) {
      this.data.repositories[this.repoKey(repo)] ??= { since: this.now(), cursor: this.now() };
    }
    await this.save();
    if (schedule) {
      this.timer = setInterval(() => { void this.tick(); }, this.config.pollSeconds * 1000);
      this.timer.unref();
      void this.tick();
    }
  }
  private repoKey(repo: GitLabRepository) { return JSON.stringify([this.config.url, this.config.executorProfile, repo.project]); }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const writing = this.writing.then(() => writeFileAtomic(this.path, snapshot, { mode: 0o600 }));
    this.writing = writing.catch(() => { this.lastError = 'Cannot persist GitLab CI state'; this.abort.abort(); });
    return writing;
  }
  tick(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    return this.polling ??= this.poll().catch(error => {
      if (!this.abort.signal.aborted) this.lastError = error instanceof GitLabError ? error.message : 'GitLab CI polling failed';
    }).finally(() => { this.polling = undefined; this.kickWorker(); });
  }
  private async poll(): Promise<void> {
    let failed = false;
    for (const repo of this.config.repositories) {
      this.abort.signal.throwIfAborted();
      const cursor = this.data.repositories[this.repoKey(repo)]!;
      const until = this.now();
      try {
        const pipelines = await this.io.pipelines(repo.project, Math.max(cursor.since, cursor.cursor - 120_000), until, this.abort.signal);
        for (const pipeline of pipelines) {
          if (pipeline.status !== 'failed' || !Number.isSafeInteger(pipeline.id) ||
            (repo.refs.length && !repo.refs.includes(pipeline.ref))) continue;
          const failures = await this.io.failures(repo.project, pipeline.id, this.abort.signal);
          const id = failureId(this.config.url, repo.project, pipeline.id, failures);
          if (this.data.runs.some(r => r.id === id)) continue;
          this.data.runs.push({ id, repository: repo, pipeline, failures, url: this.config.url, executorProfile: this.config.executorProfile,
            createdAt: this.now(), updatedAt: this.now(),
            attempts: 0, retryAt: 0, state: 'queued' });
          await this.save();
          this.kickWorker();
        }
        cursor.cursor = until;
        await this.save();
      } catch (error) {
        this.abort.signal.throwIfAborted();
        failed = true;
        this.lastError = error instanceof GitLabError ? error.message : 'GitLab CI polling failed';
      }
    }
    if (!failed) this.lastError = undefined;
    this.data.lastPollAt = this.now(); this.data.lastError = this.lastError;
    // Results remain on disk; retain a month of compact deduplication records.
    this.data.runs = this.data.runs.filter(r => ['queued', 'running', 'ready'].includes(r.state) || r.updatedAt > this.now() - 30 * 86400_000);
    await this.save();
  }
  private kickWorker(): void {
    if (this.worker || this.abort.signal.aborted) return;
    this.worker = this.drain().catch(() => {
      if (!this.abort.signal.aborted) this.lastError = 'GitLab CI worker failed';
    }).finally(() => { this.worker = undefined; });
  }
  private async drain(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const belongs = (r: CiRun) => r.url === this.config.url && r.executorProfile === this.config.executorProfile &&
        this.config.repositories.some(repo => repo.project === r.repository.project && (!repo.refs.length || repo.refs.includes(r.pipeline.ref)));
      const delivery = this.data.runs.find(r => belongs(r) && ['ready', 'failed', 'obsolete'].includes(r.state) &&
        r.topic && !r.deliveredAt && (r.deliveryAttempts ?? 0) < 3 && r.retryAt <= this.now());
      if (delivery && this.io.deliver) {
        delivery.deliveryAttempts = (delivery.deliveryAttempts ?? 0) + 1;
        await this.save();
        try {
          await this.io.deliver(delivery, this.abort.signal);
          this.abort.signal.throwIfAborted();
          delivery.deliveredAt = this.now();
          if (delivery.state === 'ready') delivery.state = 'done';
        } catch {
          delivery.retryAt = this.now() + 60_000 * 2 ** (delivery.deliveryAttempts - 1);
        }
        await this.save();
        continue;
      }
      const run = this.data.runs.find(r => r.state === 'queued' && r.retryAt <= this.now() &&
        belongs(r));
      if (!run) return;
      run.state = 'running'; run.attempts++; run.updatedAt = this.now();
      await this.save();
      try {
        if (!run.topic && this.io.announce) {
          run.topic = await this.io.announce(run, this.abort.signal);
          await this.save();
          this.abort.signal.throwIfAborted();
        }
        const resultPath = await this.io.analyze(run, this.abort.signal);
        this.abort.signal.throwIfAborted();
        run.resultPath = resultPath;
        run.state = resultPath ? this.io.deliver ? 'ready' : 'done' : 'obsolete';
        run.retryAt = 0;
        run.error = undefined;
      } catch (error) {
        run.state = run.attempts < 3 ? 'queued' : 'failed';
        run.retryAt = this.now() + 60_000 * 2 ** (run.attempts - 1);
        run.error = this.abort.signal.aborted ? 'Bridge interrupted the analysis' :
          error instanceof GitLabError ? error.message : 'CI analysis failed; see the private run directory';
      }
      run.updatedAt = this.now();
      await this.save();
    }
  }
  async idle(): Promise<void> { await this.polling; await this.worker; }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.idle();
    await this.writing;
  }
}
