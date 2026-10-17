import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { normalizeGitLabCi, validateGitLabCi } from '../../../src/gitlab-ci/config';
import { configureCiWatch } from '../../../src/cli/commands/ci-watch';

it('keeps CI watch disabled unless explicitly enabled and validates enabled settings', () => {
  expect(normalizeGitLabCi(undefined)).toMatchObject({ enabled: false, pollSeconds: 60 });
  const config = normalizeGitLabCi({ enabled: true, url: 'https://gitlab.test', executorProfile: 'codex',
    outputDir: '/private/ci', repositories: [{ project: 'data_platform/3fs-vnext' }] });
  expect(() => validateGitLabCi(config)).not.toThrow();
  expect(() => validateGitLabCi({ ...config, url: 'http://gitlab.test' })).toThrow('HTTPS');
  expect(() => validateGitLabCi({ ...config, repositories: [...config.repositories, ...config.repositories] })).toThrow('unique');
});

it('saves CI settings without dropping other root fields or profile preferences', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-config-'));
  const path = join(dir, 'config.json');
  const root = createRootConfig('codex', createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' },
    accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } } }));
  await saveRootConfig(root, path);
  const before = (await loadRootConfig(path))!.profiles;
  const settings = normalizeGitLabCi({ enabled: true, executorProfile: 'codex', url: 'https://gitlab.test', outputDir: dir,
    repositories: [{ project: 'group/repo' }] });
  const input = join(dir, 'ci.json'); await writeFile(input, JSON.stringify(settings));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { await configureCiWatch(input, { config: path }); } finally { output.mockRestore(); }
  const saved = (await loadRootConfig(path))!;
  expect(saved.gitlabCi).toEqual(settings);
  expect(saved.profiles).toEqual(before);
  saved.profiles.codex!.preferences.model = 'another-model';
  await saveRootConfig(saved, path);
  expect((await loadRootConfig(path))!.gitlabCi).toEqual(settings);
});
