import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, runtimeProfileConfig, saveRootConfig } from '../../../src/config/profile-store';
import { normalizeGitLabCi } from '../../../src/gitlab-ci/config';
import { GitLabCiManager } from '../../../src/gitlab-ci/manager';
import { GitLabCiService } from '../../../src/gitlab-ci/service';
import * as runtime from '../../../src/runtime/agent-runtime';

vi.mock('../../../src/gitlab-ci/client', () => ({ GitLabClient: vi.fn(), loadGitLabToken: vi.fn(async () => 'fixture') }));
vi.mock('../../../src/gitlab-ci/service', () => ({ GitLabCiService: vi.fn(function () { return { start: vi.fn(), close: vi.fn() }; }) }));
vi.mock('../../../src/runtime/agent-runtime', () => ({ createRuntimeAgent: vi.fn(() => ({})) }));
const managers: GitLabCiManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); vi.clearAllMocks(); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ci-manager-')); const path = join(dir, 'config.json');
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' },
    accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } } });
  const root = createRootConfig('codex', profile);
  root.gitlabCi = normalizeGitLabCi({ enabled: true, executorProfile: 'codex', url: 'https://gitlab.test', outputDir: dir, repositories: [{ project: 'a/b' }] });
  await saveRootConfig(root, path);
  let online = true;
  const controls: Controls = { cfg: runtimeProfileConfig(root, 'codex'), profileConfig: profile, profile: 'codex', configPath: path,
    ownerRefreshState: 'ok', processId: 'test', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {} };
  const create = () => { const m = new GitLabCiManager(path, () => online ? controls : undefined, dir); managers.push(m); return m; };
  return { create, root, path, dir, offline: () => { online = false; } };
}

it('leases one watcher, uses the normal runtime, and releases it when the profile stops', async () => {
  const s = await setup(); const first = s.create(); const second = s.create();
  await first.reconcile(); await second.reconcile();
  expect(GitLabCiService).toHaveBeenCalledTimes(1);
  expect(second.error).toBeDefined();
  expect(runtime.createRuntimeAgent).not.toHaveBeenCalled(); // only the inbox worker creates an agent
  await first.close(); await second.reconcile(); expect(second.error).toBeUndefined();
  const instance = vi.mocked(GitLabCiService).mock.results.at(-1)!.value as GitLabCiService;
  s.offline(); await second.reconcile(); expect(instance.close).toHaveBeenCalled();
});

it('reloads configuration without restarting an unchanged watcher', async () => {
  const s = await setup(); const manager = s.create(); await manager.reconcile(); await manager.reconcile();
  expect(GitLabCiService).toHaveBeenCalledTimes(1);
  s.root.gitlabCi!.repositories.push({ project: 'a/c', refs: [], sourceDir: '' }); await saveRootConfig(s.root, s.path);
  await manager.reconcile(); expect(GitLabCiService).toHaveBeenCalledTimes(2);
  const instance = vi.mocked(GitLabCiService).mock.results.at(-1)!.value as GitLabCiService;
  s.root.gitlabCi!.enabled = false; await saveRootConfig(s.root, s.path); await manager.reconcile();
  expect(instance.close).toHaveBeenCalled();
});
