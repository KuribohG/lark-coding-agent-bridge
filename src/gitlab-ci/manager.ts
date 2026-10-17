import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { Controls } from '../commands';
import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig } from '../config/profile-store';
import { log } from '../core/logger';
import { createRuntimeAgent } from '../runtime/agent-runtime';
import { GitLabClient, loadGitLabToken } from './client';
import { normalizeGitLabCi, validateGitLabCi } from './config';
import { analyzeCi } from './processor';
import { GitLabCiService } from './service';
import { ciNotification } from './notification';

export class GitLabCiManager {
  private service?: GitLabCiService;
  private unlock?: () => Promise<void>;
  private fingerprint = '';
  private notification?: ReturnType<typeof ciNotification>;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  error?: string;
  constructor(private configPath: string, private controls: (profile: string) => Controls | undefined, private rootDir?: string) {
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
      controls?.profileConfig.agentKind, controls?.profileConfig.mode, controls?.botIdentity]);
    if (this.service && controls && fingerprint === this.fingerprint) return;
    await this.stop();
    if (!config.enabled || !controls) { this.error = config.enabled ? 'GitLab CI executor profile is offline' : undefined; return; }
    validateGitLabCi(config);
    if (controls.profileConfig.agentKind !== 'codex' || controls.profileConfig.mode === 'team') throw new Error('GitLab CI requires a personal Codex executor profile');
    const client = new GitLabClient(config.url, await loadGitLabToken(config));
    const paths = resolveAppPaths({ rootDir: this.rootDir, profile: config.executorProfile });
    const folder = join(dirname(this.configPath), 'gitlab-ci');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const lease = join(folder, 'service');
    await writeFile(lease, '', { flag: 'a', mode: 0o600 });
    this.unlock = await lockfile.lock(lease, { stale: 60_000, update: 10_000, retries: 0,
      onCompromised: () => { void this.close(); } });
    try {
      const agent = createRuntimeAgent(controls.profileConfig, { ...paths, configPath: this.configPath });
      if (controls.botIdentity) agent.setBotIdentity?.(controls.botIdentity);
      const notification = ciNotification(config, this.rootDir);
      this.notification = notification;
      this.service = new GitLabCiService(join(folder, 'state.json'), config, {
        ...notification,
        pipelines: (...args) => client.pipelines(...args), failures: (...args) => client.failures(...args),
        analyze: async (run, signal) => {
          const path = await analyzeCi(run, config, client, agent, signal);
          log.info('gitlab-ci', path ? 'analysis-complete' : 'failure-obsolete', { project: run.repository.project, pipeline: run.pipeline.id, resultPath: path });
          return path;
        },
      });
      await this.service.start();
      this.fingerprint = fingerprint; this.error = undefined;
      log.info('gitlab-ci', 'watch-started', { repositories: config.repositories.map(r => r.project), model: config.model });
    } catch (error) { await this.stop(); throw error; }
  }
  private async stop(): Promise<void> {
    this.notification?.close(); this.notification = undefined;
    await this.service?.close(); this.service = undefined;
    await this.unlock?.(); this.unlock = undefined;
    this.fingerprint = '';
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    await this.chain; await this.stop();
  }
}
