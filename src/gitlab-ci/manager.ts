import { supportsBackgroundProfile } from '../runtime/agent-capabilities';
import { backgroundModelSettings } from '../runtime/background-model';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { Controls } from '../commands';
import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig } from '../config/profile-store';
import { log } from '../core/logger';
import { InboxTaskSources } from '../inbox/task-sources';
import { GitLabClient, loadGitLabToken } from './client';
import { normalizeGitLabCi, validateGitLabCi } from './config';
import { ciAssessment, ciTaskDriver, ciTaskEvent } from './inbox-source';
import { GitLabCiService } from './service';

export class GitLabCiManager {
  private service?: GitLabCiService;
  private unlock?: () => Promise<void>;
  private fingerprint = '';
  private source?: Awaited<ReturnType<InboxTaskSources['connect']>>;
  private sources: InboxTaskSources;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  error?: string;
  constructor(private configPath: string, private controls: (profile: string) => Controls | undefined, private rootDir?: string, sources?: InboxTaskSources) {
    this.sources = sources ?? new InboxTaskSources(configPath, rootDir);
    this.timer = setInterval(() => { void this.reconcile(); }, 15_000);
    this.timer.unref();
  }
  reconcile(): Promise<void> {
    const next = this.chain.then(() => this.reload()).catch(error => {
      this.error = error instanceof Error ? error.message : 'GitLab CI setup failed';
      log.warn('gitlab-ci', 'setup-failed', { error: this.error });
    });
    this.chain = next; return next;
  }
  private async reload(): Promise<void> {
    if (this.closed) return;
    const root = await loadRootConfig(this.configPath);
    const config = normalizeGitLabCi(root?.gitlabCi);
    const controls = this.controls(config.executorProfile);
    const fingerprint = JSON.stringify([config, controls?.profileConfig.codex, controls?.profileConfig.sandbox,
      controls?.profileConfig.agentKind, controls?.profileConfig.mode, controls?.profileConfig.preferences, controls?.botIdentity]);
    if (this.source && fingerprint === this.fingerprint) return;
    await this.stop();
    if (!config.executorProfile) { this.error = undefined; return; }
    validateGitLabCi(config);
    if (controls && !supportsBackgroundProfile(controls.profileConfig)) throw new Error('GitLab CI requires a personal executor profile with background analysis support');
    const enabled = config.enabled && Boolean(controls);
    const client = enabled ? new GitLabClient(config.url, await loadGitLabToken(config)) : undefined;
    const paths = resolveAppPaths({ rootDir: this.rootDir, profile: config.executorProfile });
    const folder = join(dirname(this.configPath), 'gitlab-ci');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const lease = join(folder, 'service');
    await writeFile(lease, '', { flag: 'a', mode: 0o600 });
    this.unlock = await lockfile.lock(lease, { stale: 60_000, update: 10_000, retries: 0,
      onCompromised: () => { void this.close(); } });
    try {
      const settings = controls ? await backgroundModelSettings(controls.profileConfig, paths.profileDir, config.model, 'max') : {};
      this.source = await this.sources.connect({ id: 'gitlab-ci', label: 'GitLab CI', profile: config.executorProfile,
        enabled, controls, notification: config.notification, settings, assessment: ciAssessment, driver: ciTaskDriver(config, client) });
      this.fingerprint = fingerprint;
      if (!client) { this.error = config.enabled ? 'GitLab CI executor profile is offline' : undefined; return; }
      const source = this.source;
      this.service = new GitLabCiService(join(folder, 'state.json'), config, {
        pipelines: (...args) => client.pipelines(...args), failures: (...args) => client.failures(...args),
        submit: async (run, signal) => {
          signal.throwIfAborted();
          return (await source.submit(await ciTaskEvent(run, config))).id;
        },
      });
      await this.service.start();
      this.fingerprint = fingerprint; this.error = undefined;
      log.info('gitlab-ci', 'watch-started', { repositories: config.repositories.map(r => r.project), model: settings.model ?? 'default' });
    } catch (error) { await this.stop(); throw error; }
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
