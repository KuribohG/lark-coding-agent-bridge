import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { normalizeInbox } from '../../../src/inbox/config';
import { inboxTriageService } from '../../../src/inbox/model-routing';
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
  return { dir, claude, codex };
}

it('keeps Claude on its own execution settings', async () => {
  const h = await setup();
  const config = normalizeInbox({ executorProfile: 'claude', analysisModel: 'sonnet' });
  expect(await backgroundModelSettings(h.claude, h.dir, config.analysisModel)).toEqual({ model: 'sonnet', reasoningEffort: 'high' });
  expect(await backgroundModelSettings(h.claude, h.dir)).toEqual({ model: 'sonnet', reasoningEffort: 'high' });
});

it('follows the Codex profile unless an analysis model is set', async () => {
  const h = await setup();
  expect(normalizeInbox({ executorProfile: 'codex' }).analysisModel).toBe('');
  expect(await backgroundModelSettings(h.codex, h.dir, '')).toEqual({ model: 'profile-model', reasoningEffort: 'high' });
  expect((await backgroundModelSettings(h.codex, h.dir, 'override')).model).toBe('override');
});

it('leaves model and effort unset when Claude should use project/managed CLI defaults', async () => {
  const h = await setup(); h.claude.preferences.model = undefined; h.claude.preferences.reasoningEffort = undefined;
  await writeFile(join(h.dir, 'settings.json'), JSON.stringify({ model: 'configured-claude', effortLevel: 'high' }));
  expect(await backgroundModelSettings(h.claude, h.dir, '')).toEqual({ model: undefined, reasoningEffort: undefined });
});

it('requires a standalone screening service', () => {
  const config = normalizeInbox({ executorProfile: 'codex', triageProfile: 'codex' });
  expect(config).not.toHaveProperty('triageProfile');
  expect(() => inboxTriageService(config, { modelServices: {} })).toThrow('请选择独立筛选模型服务');
});

it('round-trips independent model settings and resolves omitted CI models per executor', async () => {
  const h = await setup();
  const config = normalizeInbox({ executorProfile: 'claude', analysisModel: '', triageService: 'screen', triageModel: '' });
  expect(normalizeInbox(JSON.parse(JSON.stringify(config)))).toEqual(config);
  const ci = normalizeGitLabCi({ executorProfile: 'claude' });
  expect(ci.model).toBeUndefined();
  expect((await backgroundModelSettings(h.claude, h.dir, ci.model, 'max')).model).toBe('sonnet');
  expect(await backgroundModelSettings(h.codex, h.dir, ci.model, 'max')).toEqual({ model: 'deepseek-flash', reasoningEffort: 'max' });
  expect(normalizeGitLabCi({ model: '' }).model).toBe('');
});
