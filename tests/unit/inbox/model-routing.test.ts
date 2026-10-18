import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { normalizeInbox } from '../../../src/inbox/config';
import { inboxTriageProfile, loadInboxTriageModel } from '../../../src/inbox/model-routing';
import { backgroundModelSettings } from '../../../src/runtime/background-model';
import { normalizeGitLabCi } from '../../../src/monitoring/sources/gitlab-ci/config';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-model-routing-')); dirs.push(dir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir); vi.stubEnv('ANTHROPIC_MODEL', undefined); vi.stubEnv('CLAUDE_CODE_EFFORT_LEVEL', undefined);
  await writeFile(join(dir, 'config.toml'), 'model="provider-default"\nmodel_provider="test"\n[model_providers.test]\nbase_url="https://model.test/v1"\nexperimental_bearer_token="fixture"\n');
  const accounts = { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' as const } };
  const claude = createDefaultProfileConfig({ accounts, agentKind: 'claude', preferences: { model: 'sonnet', reasoningEffort: 'high' } });
  const codex = createDefaultProfileConfig({ accounts, agentKind: 'codex', codex: { binaryPath: 'codex', codexHome: dir }, preferences: { model: 'profile-model', reasoningEffort: 'high' } });
  return { dir, claude, codex, profiles: { claude, codex } };
}

it('routes screening to the selected service while Claude inherits its own execution settings', async () => {
  const h = await setup();
  const config = normalizeInbox({ executorProfile: 'claude', triageProfile: 'codex', analysisModel: 'sonnet', triageModel: 'cheap-screening' });
  expect(await loadInboxTriageModel(config, inboxTriageProfile(config, h.profiles)))
    .toMatchObject({ url: 'https://model.test/v1/responses', model: 'cheap-screening', key: 'fixture' });
  expect(await backgroundModelSettings(h.claude, h.dir, config.analysisModel)).toEqual({ model: 'sonnet', reasoningEffort: 'high' });
  expect(await backgroundModelSettings(h.claude, h.dir)).toEqual({ model: 'sonnet', reasoningEffort: 'high' });
});

it('does not pass a Claude model to a separate screening service by default', async () => {
  const h = await setup();
  const config = normalizeInbox({ executorProfile: 'claude', triageProfile: 'codex', analysisModel: 'sonnet' });
  expect((await loadInboxTriageModel(config, h.codex)).model).toBe('deepseek-flash');
  expect((await loadInboxTriageModel({ ...config, triageModel: '' }, h.codex)).model).toBe('profile-model');
});

it('preserves legacy Codex Flash and max effort plus explicit default and model overrides', async () => {
  const h = await setup();
  const config = normalizeInbox({ executorProfile: 'codex' });
  expect((await loadInboxTriageModel(config, inboxTriageProfile(config, h.profiles))).model).toBe('deepseek-flash');
  expect(await backgroundModelSettings(h.codex, h.dir, config.analysisModel)).toEqual({ model: 'deepseek-flash', reasoningEffort: 'max' });
  expect(await backgroundModelSettings(h.codex, h.dir, '')).toEqual({ model: 'profile-model', reasoningEffort: 'high' });
  expect((await loadInboxTriageModel({ ...config, analysisModel: 'override' }, h.codex)).model).toBe('override');
});

it('leaves model and effort unset when Claude should use project/managed CLI defaults', async () => {
  const h = await setup(); h.claude.preferences.model = undefined; h.claude.preferences.reasoningEffort = undefined;
  await writeFile(join(h.dir, 'settings.json'), JSON.stringify({ model: 'configured-claude', effortLevel: 'high' }));
  expect(await backgroundModelSettings(h.claude, h.dir, '')).toEqual({ model: undefined, reasoningEffort: undefined });
});

it('rejects unavailable or team screening sources instead of silently selecting credentials', async () => {
  const h = await setup();
  for (const triageProfile of [undefined, 'missing', 'team']) {
    expect(() => inboxTriageProfile(normalizeInbox({ executorProfile: 'claude', triageProfile }),
      { ...h.profiles, team: { ...h.codex, mode: 'team' } })).toThrow('筛选 profile');
  }
});

it('reads an isolated screening profile home instead of the process-wide Codex home', async () => {
  const h = await setup(); vi.stubEnv('CODEX_HOME', h.dir);
  h.codex.codex = { binaryPath: 'codex', inheritCodexHome: false };
  const home = join(h.dir, 'isolated-profile', 'codex-home'); await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.toml'), 'model="isolated"\nmodel_provider="test"\n[model_providers.test]\nbase_url="https://isolated.test/v1"\nexperimental_bearer_token="isolated-fixture"\n');
  const config = normalizeInbox({ executorProfile: 'claude', triageProfile: 'codex', triageModel: '' });
  await expect(loadInboxTriageModel(config, h.codex)).rejects.toThrow('配置目录');
  expect(await loadInboxTriageModel(config, h.codex, join(h.dir, 'isolated-profile')))
    .toMatchObject({ url: 'https://isolated.test/v1/responses', key: 'isolated-fixture' });
});

it('round-trips independent model settings and resolves omitted CI models per executor', async () => {
  const h = await setup();
  const config = normalizeInbox({ executorProfile: 'claude', analysisModel: '', triageProfile: 'codex', triageModel: '' });
  expect(normalizeInbox(JSON.parse(JSON.stringify(config)))).toEqual(config);
  const ci = normalizeGitLabCi({ executorProfile: 'claude' });
  expect(ci.model).toBeUndefined();
  expect((await backgroundModelSettings(h.claude, h.dir, ci.model, 'max')).model).toBe('sonnet');
  expect(await backgroundModelSettings(h.codex, h.dir, ci.model, 'max')).toEqual({ model: 'deepseek-flash', reasoningEffort: 'max' });
  expect(normalizeGitLabCi({ model: '' }).model).toBe('');
});
