import { join } from 'node:path';
import type { MonitorHost } from '../../host';
import { SourceController, type SourceKind } from '../../source-controller';
import type { WorkItemSources } from '../../../work-items/registry';
import { GitLabClient, loadGitLabToken } from './client';
import { normalizeGitLabCi, validateGitLabCi, type GitLabCiConfig } from './config';
import { ciAssessment, ciTaskDriver, ciTaskEvent } from './inbox-source';
import { GitLabCiService } from './service';

const gitlabCiKind: SourceKind<GitLabCiConfig, GitLabCiService> = {
  id: 'gitlab-ci', label: 'GitLab CI', section: 'gitlab_ci', folder: 'gitlab-ci',
  logTag: 'gitlab-ci', setupError: 'GitLab CI setup failed',
  config: root => normalizeGitLabCi(root?.gitlabCi),
  describe: config => ({ repositories: config.repositories.map(r => r.project), model: config.model ?? 'default' }),
  async setup(config) {
    validateGitLabCi(config);
    const client = config.enabled ? new GitLabClient(config.url, await loadGitLabToken(config)) : undefined;
    return {
      options: view => ({ notification: config.notification, model: config.model, reasoningEffort: 'max',
        status: () => ({ error: view.error() }), assessment: ciAssessment, driver: ciTaskDriver(config, client) }),
      start: client && (async (connection, folder) => {
        const service = new GitLabCiService(join(folder, 'state.json'), config, {
          pipelines: (...args) => client.pipelines(...args), failures: (...args) => client.failures(...args),
          submit: async (run, signal) => {
            signal.throwIfAborted();
            return (await connection.submit(ciTaskEvent(run, config))).id;
          },
        });
        await service.start();
        return service;
      }),
    };
  },
};

export class GitLabCiManager extends SourceController<GitLabCiConfig, GitLabCiService> {
  constructor(configPath: string, host: MonitorHost, sources?: WorkItemSources) {
    super(gitlabCiKind, configPath, host, sources);
  }
}
