import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { modelRunArguments, readModelEnvironment, resolveModelSettings } from '../../../src/agent/model-settings';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe('model settings resolution', () => {
  const environment = {
    defaults: { model: 'provider/model', reasoningEffort: 'medium' as const },
    models: [{ value: 'provider/model', label: 'Model', reasoningEfforts: ['high'], defaultReasoningEffort: 'high' }],
  };

  it('leaves inherited flags to the CLI even when local metadata differs from project settings', () => {
    const native = resolveModelSettings({}, {}, environment);
    expect(native.notice).toBeUndefined();
    expect(modelRunArguments(native)).toEqual({ model: undefined, reasoningEffort: undefined });
    expect(modelRunArguments(resolveModelSettings({}, { model: 'provider/model' }, environment)))
      .toEqual({ model: 'provider/model', reasoningEffort: undefined });
    expect(modelRunArguments(resolveModelSettings({}, { reasoningEffort: 'low' }, environment)))
      .toEqual({ model: undefined, reasoningEffort: 'low' });
  });

  it('uses the catalog default when bridge-controlled inherited effort is incompatible', () => {
    const resolved = resolveModelSettings({ reasoningEffort: 'medium' }, { model: 'provider/model' }, environment);
    expect(resolved).toMatchObject({ reasoningEffort: 'high', effortSource: 'model', modelSource: 'scope' });
    expect(resolved.notice).toContain('不支持 medium');
  });

  it('reads a profile-local Codex catalog and tolerates a corrupt optional cache', async () => {
    const tmp = await createTmpProfile('model-catalog-');
    cleanups.push(tmp.cleanup);
    const home = join(tmp.profile, 'codex-home');
    await mkdir(home, { recursive: true });
    const profile = createDefaultProfileConfig({ agentKind: 'codex',
      accounts: { app: { id: 'app', secret: '${TEST_SECRET}', tenant: 'feishu' } },
      codex: { binaryPath: 'codex', inheritCodexHome: false },
    });
    await writeFile(join(home, 'config.toml'), 'model_catalog_json = "catalog.json"\n');
    const catalogPath = join(home, 'catalog.json');
    await writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'private/catalog-model',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low',
    }] }));
    const found = await readModelEnvironment(profile, tmp.profile);
    expect(found.models).toContainEqual(expect.objectContaining({
      value: 'private/catalog-model', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low',
    }));
    await writeFile(catalogPath, '{broken cache');
    await expect(readModelEnvironment(profile, tmp.profile)).resolves.toMatchObject({ defaults: {} });
  });
});
