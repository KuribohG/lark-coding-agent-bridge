import { GitLabCiManager } from './manager';
import type { MonitorModule } from '../../module';

export const gitlabCiMonitor: MonitorModule<GitLabCiManager> = {
  id: 'gitlab_ci',
  create: c => new GitLabCiManager(c.configPath, c.host, c.sources),
};
