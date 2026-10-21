import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { ExecutionProfile } from '../../../runtime/execution-provider';
import type { MonitorHost } from '../../host';
import { loadMonitorRoot } from '../../store';
import { log } from '../../../core/logger';
import { WorkItemSources } from '../../../work-items/registry';
import { GitLabClient, loadGitLabToken } from './client';
import { normalizeGitLabCi, validateGitLabCi } from './config';
import { ciAssessment, ciTaskDriver, ciTaskEvent } from './inbox-source';
import { GitLabCiService } from './service';

export class GitLabCiManager {
  private service?: GitLabCiService;
  private unlock?: () => Promise<void>;
  private executor?: ExecutionProfile;
  private executionError?: string;
  private fingerprint = '';
  private source?: Awaited<ReturnType<WorkItemSources['connect']>>;
  private sources: WorkItemSources;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  error?: string;
  constructor(private configPath: string, private host: MonitorHost, sources?: WorkItemSources) {
    this.sources = sources ?? new WorkItemSources(configPath);
    this.timer = setInterval(() => { void this.reconcile(); }, 15_000);
    this.timer.unref();
  }
  reconcile(): Promise<void> {
    const next = this.chain.then(() => this.reload()).catch(async error => {
      this.error = error instanceof Error ? error.message : 'GitLab CI setup failed';
      log.warn('gitlab-ci', 'setup-failed', { error: this.error });
      if (this.service) await this.refreshExecutor(this.service.config.executorProfile);
    });
    this.chain = next; return next;
  }
  private async reload(): Promise<void> {
    if (this.closed) return;
    const root = await loadMonitorRoot(this.configPath);
    if (root) this.sources.configureConcurrency(root.workItemConcurrency);
    const config = normalizeGitLabCi(root?.gitlabCi);
    if (config.enabled) await this.refreshExecutor(config.executorProfile);
    else { this.executor = undefined; this.executionError = undefined; }
    const fingerprint = JSON.stringify(config);
    if (this.source && fingerprint === this.fingerprint) {
      this.error = this.executionError; return;
    }
    await this.stop();
    if (!config.executorProfile) { this.error = undefined; return; }
    validateGitLabCi(config);
    const enabled = config.enabled;
    const client = enabled ? new GitLabClient(config.url, await loadGitLabToken(config)) : undefined;
    const folder = join(dirname(this.configPath), 'gitlab-ci');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const lease = join(folder, 'service');
    await writeFile(lease, '', { flag: 'a', mode: 0o600 });
    this.unlock = await lockfile.lock(lease, { stale: 60_000, update: 10_000, retries: 0,
      onCompromised: () => { void this.close(); } });
    try {
      this.source = await this.sources.connect(this.host.source({ id: 'gitlab-ci', label: 'GitLab CI', profile: config.executorProfile,
        enabled, executor: () => this.executor, notification: config.notification, model: config.model, reasoningEffort: 'max',
        status: () => ({ error: this.error }), assessment: ciAssessment, driver: ciTaskDriver(config, client) }));
      this.fingerprint = fingerprint;
      if (!client) { this.error = this.executionError; return; }
      const source = this.source;
      this.service = new GitLabCiService(join(folder, 'state.json'), config, {
        pipelines: (...args) => client.pipelines(...args), failures: (...args) => client.failures(...args),
        submit: async (run, signal) => {
          signal.throwIfAborted();
          return (await source.submit(await ciTaskEvent(run, config))).id;
        },
      });
      await this.service.start();
      this.fingerprint = fingerprint; this.error = this.executionError;
      log.info('gitlab-ci', 'watch-started', { repositories: config.repositories.map(r => r.project), model: config.model ?? 'default' });
    } catch (error) { await this.stop(); throw error; }
  }
  private async refreshExecutor(profile: string): Promise<void> {
    try {
      this.executor = await this.host.executors.resolve(profile);
      this.executionError = this.executor?.available ? undefined : this.executor?.error ?? '执行器暂不可用，采集继续，分析等待';
    } catch {
      this.executor = undefined; this.executionError = '执行器配置不可用，采集继续，分析等待';
    }
  }
  private async stop(): Promise<void> {
    await this.service?.close(); this.service = undefined;
    await this.source?.close(); this.source = undefined;
    await this.unlock?.(); this.unlock = undefined;
    this.fingerprint = '';
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    await this.chain; await this.stop();
  }
}
