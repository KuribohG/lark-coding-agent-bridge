import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRootConfig } from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { normalizeGitLabCi } from '../../../src/monitoring/sources/gitlab-ci/config';
import { ciFailureEvent, GitLabCiService, type CiRun, type CiState } from '../../../src/monitoring/sources/gitlab-ci/service';
import type { ObservationJournal } from '../../../src/work-items/events';
import { createMonitorHost } from '../../../src/plugins/work-items/runtime';
import { Supervisor } from '../../../src/runtime/supervisor';
import { createBuiltinPlugins } from '../../../src/plugins/defaults';
import type { WorkItemsPlugin } from '../../../src/plugins/work-items/plugin';
import { saveWithMonitors } from '../../helpers/monitors';

vi.mock('../../../src/monitoring/sources/gitlab-ci/client', () => ({ GitLabClient: class {}, loadGitLabToken: async () => 'fixture' }));
vi.mock('../../../src/monitoring/sources/gitlab-ci/service', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/monitoring/sources/gitlab-ci/service')>(),
  GitLabCiService: vi.fn(function (config, io, journal) {
    return { config, io, journal, start: vi.fn(), close: vi.fn() };
  }),
}));

it('keeps accepting CI observations after stopping the Lark profile, and retains them when execution is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-lifecycle-')); const path = join(dir, 'config.json');
  const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_test', secret: 'fixture', tenant: 'feishu' } } });
  const root = createRootConfig('local', profile);
  root.gitlabCi = normalizeGitLabCi({ enabled: true, executorProfile: 'local', url: 'https://gitlab.test', outputDir: dir,
    repositories: [{ project: 'a/b' }] });
  await saveWithMonitors(root, path);
  const host = createMonitorHost(path, dir);
  host.executors = { resolve: vi.fn(async () => undefined) };
  const disconnect = vi.fn(async () => {});
  const startChannelFn = vi.fn(async () => ({ channel: { botIdentity: { name: 'test' } }, disconnect })) as unknown as NonNullable<ConstructorParameters<typeof Supervisor>[0]['startChannelFn']>;
  const supervisor = new Supervisor({
    configPath: path,
    rootDir: dir,
    runPreflight: false,
    startChannelFn,
    plugins: createBuiltinPlugins({ monitorHost: host }),
  });
  try {
    await supervisor.startProfile('local');
    const collector = vi.mocked(GitLabCiService).mock.results[0]!.value as {
      close(): Promise<void>;
      config: Parameters<typeof ciFailureEvent>[1];
      journal: ObservationJournal<CiState>;
    };
    await supervisor.stopProfile('local');
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(collector.close).not.toHaveBeenCalled();
    expect(GitLabCiService).toHaveBeenCalledTimes(1);
    const run: CiRun = { id: 'a'.repeat(32), url: 'https://gitlab.test', executorProfile: 'local',
      repository: { project: 'a/b', refs: [], sourceDir: '' }, pipeline: { id: 1, status: 'failed', ref: 'main', sha: 'b'.repeat(40), web_url: '', updated_at: new Date().toISOString() },
      createdAt: Date.now(), failures: [] };
    await collector.journal.commit([ciFailureEvent(run, collector.config)], { version: 1, repositories: {} });
    const item = supervisor.plugin<WorkItemsPlugin>('work-items')!
      .sources.list().find(job => job.external?.key === run.id);
    expect(item).toMatchObject({ state: 'queued', analysisRequested: true, external: { analysisAttempts: 0 } });
  } finally { await supervisor.shutdown(); await rm(dir, { recursive: true, force: true }); }
});
