import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { prepareManagedCodexConfig } from '../../../src/agent/codex/managed-config';
import type { ResolvedModelProvider } from '../../../src/model-provider/types';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const provider: ResolvedModelProvider = { id: 'high-five-ai', displayName: 'high-five-ai', model: 'model-a', env: { TEST_KEY: 'test-secret' }, codex: { providerId: 'high-five-ai', name: 'high-five-ai', baseUrl: 'https://example.com/v1', wireApi: 'responses', apiKeyEnv: 'TEST_KEY' } };
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'codex-config-')); dirs.push(dir); return dir; }

it('overlays bridge routing while preserving native settings and keeping credentials out of config', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'config.toml'), 'model_provider="custom"\nmodel="old"\nmodel_verbosity="low"\n[mcp_servers.demo]\ncommand="my-mcp"\n[model_providers.high-five-ai]\nrequest_max_retries=8\nexperimental_bearer_token="old-secret"\n');
  const first = await prepareManagedCodexConfig(dir, provider);
  expect(first.changed).toBe(true);
  const text = await readFile(join(dir, 'config.toml'), 'utf8');
  expect(parse(text)).toMatchObject({ model_provider: 'high-five-ai', model: 'model-a', model_verbosity: 'low', mcp_servers: { demo: { command: 'my-mcp' } }, model_providers: { 'high-five-ai': { request_max_retries: 8, env_key: 'TEST_KEY' } } });
  expect(text).not.toContain('test-secret');
  expect(text).not.toContain('old-secret');
  expect((await prepareManagedCodexConfig(dir, provider)).changed).toBe(true);
  await first.commit?.();
  expect((await prepareManagedCodexConfig(dir, provider)).changed).toBe(false);
  expect((await prepareManagedCodexConfig(dir, { ...provider, env: { TEST_KEY: 'rotated-secret' } })).changed).toBe(true);
});

it('refuses symlinked configuration and leaves its source untouched', async () => {
  const dir = await directory();
  const original = join(dir, 'original.toml');
  await writeFile(original, 'model="untouched"\n');
  await symlink(original, join(dir, 'config.toml'));
  await expect(prepareManagedCodexConfig(dir, provider)).rejects.toThrow('independent file');
  expect(await readFile(original, 'utf8')).toBe('model="untouched"\n');
});

it('does not overwrite a malformed native configuration', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'config.toml'), 'malformed = [');
  await expect(prepareManagedCodexConfig(dir, provider)).rejects.toThrow();
  expect(await readFile(join(dir, 'config.toml'), 'utf8')).toBe('malformed = [');
});

it('drops Bridge routing when a launch resolves no provider', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'config.toml'), 'model_provider="lark_high-five-ai_abc"\nmodel="model-a"\nmodel_verbosity="low"\n[model_providers.lark_high-five-ai_abc]\nbase_url="https://example.com/v1"\nenv_key="LARK_MODEL_PROVIDER_KEY_ABC"\n[model_providers.native]\nbase_url="https://native.example.com/v1"\n');
  const prepared = await prepareManagedCodexConfig(dir);
  expect(prepared.changed).toBe(true);
  expect(prepared.id).toBe('lark_high-five-ai_abc');
  expect(prepared.model).toBe('model-a');
  const text = await readFile(join(dir, 'config.toml'), 'utf8');
  expect(parse(text)).toMatchObject({ model_verbosity: 'low', model_providers: { native: { base_url: 'https://native.example.com/v1' } } });
  expect(parse(text)).not.toHaveProperty('model_provider');
  expect(parse(text)).not.toHaveProperty('model');
  expect(text).not.toContain('LARK_MODEL_PROVIDER_KEY_');
  expect((await prepareManagedCodexConfig(dir)).changed).toBe(false);
});

it('leaves a native configuration alone when no provider is resolved', async () => {
  const dir = await directory();
  const native = 'model_provider="native"\nmodel="native-model"\n[model_providers.native]\nbase_url="https://native.example.com/v1"\n';
  await writeFile(join(dir, 'config.toml'), native);
  const prepared = await prepareManagedCodexConfig(dir);
  expect(prepared.changed).toBe(false);
  expect(prepared.id).toBe('native');
  expect(await readFile(join(dir, 'config.toml'), 'utf8')).toBe(native);
});

it('reports the routing it replaced and can restore the previous file', async () => {
  const dir = await directory();
  const native = 'model_provider="native"\nmodel="native-model"\n[model_providers.native]\nbase_url="https://native.example.com/v1"\n';
  await writeFile(join(dir, 'config.toml'), native);
  const prepared = await prepareManagedCodexConfig(dir, provider);
  expect(prepared.previous).toEqual({ id: 'native', model: 'native-model' });
  await prepared.revert();
  expect(await readFile(join(dir, 'config.toml'), 'utf8')).toBe(native);
});
