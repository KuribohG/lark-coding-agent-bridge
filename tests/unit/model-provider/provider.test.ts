import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_MODEL_PROVIDER,
  ModelProviderRegistry,
  composeProviderSelection,
  selectedProvider,
} from '../../../src/model-provider/provider';
import type { ModelServiceConfig } from '../../../src/model-service/config';

const previousKey = process.env.PROVIDER_TEST_KEY;

afterEach(() => {
  if (previousKey === undefined) delete process.env.PROVIDER_TEST_KEY;
  else process.env.PROVIDER_TEST_KEY = previousKey;
});

describe('agent model provider registry', () => {
  const services: Record<string, ModelServiceConfig> = {
    deepseek: {
      protocol: 'responses',
      baseUrl: 'https://gateway.example/v1',
      model: 'deepseek-flash',
      apiKey: { source: 'env', id: 'PROVIDER_TEST_KEY' },
    },
  };

  it('binds a Responses service to Pi without writing the credential to its extension', async () => {
    process.env.PROVIDER_TEST_KEY = 'private-provider-key';
    const resolved = await new ModelProviderRegistry(services).resolve('pi', 'deepseek/deepseek-flash');
    expect(resolved).toMatchObject({
      id: 'deepseek',
      env: expect.objectContaining({ LARK_MODEL_PROVIDER_KEY_73395B78866F: 'private-provider-key' }),
      pi: {
        baseUrl: 'https://gateway.example/v1',
        api: 'openai-responses',
        apiKeyEnv: 'LARK_MODEL_PROVIDER_KEY_73395B78866F',
        model: { id: 'deepseek-flash' },
      },
    });
    expect(resolved?.model).toMatch(/^lark_deepseek_[a-f0-9]+\/deepseek-flash$/);
    expect(JSON.stringify(resolved?.pi)).not.toContain('private-provider-key');
  });

  it('binds the same Responses service to Codex with environment-backed auth', async () => {
    process.env.PROVIDER_TEST_KEY = 'private-provider-key';
    const resolved = await new ModelProviderRegistry(services).resolve('codex', 'deepseek/deepseek-v4-pro');
    expect(resolved).toMatchObject({
      id: 'deepseek',
      model: 'deepseek-v4-pro',
      codex: {
        baseUrl: 'https://gateway.example/v1',
        wireApi: 'responses',
      },
    });
    if (!resolved?.codex) throw new Error('expected API-key provider');
    expect(resolved.codex.apiKeyEnv).toMatch(/^LARK_MODEL_PROVIDER_KEY_[A-F0-9]+$/);
  });

  it('uses the configured service name for Codex and resolves pending selections without credentials', async () => {
    delete process.env.PROVIDER_TEST_KEY;
    const registry = new ModelProviderRegistry(services);
    const selected = await registry.resolve('codex', 'deepseek/deepseek-flash', false);
    expect(selected?.codex?.providerId).toBe('deepseek');
    expect(selected?.env).toEqual({});
    process.env.PROVIDER_TEST_KEY = 'startup-key';
    const startup = await registry.resolveStartup('codex', 'custom-model', 'deepseek');
    expect(startup).toMatchObject({ id: 'deepseek', model: 'custom-model', codex: { providerId: 'deepseek' } });
    expect((await registry.resolveStartup('codex'))?.model).toBe('deepseek-flash');
  });

  it('leaves native bare model selections unchanged', async () => {
    await expect(new ModelProviderRegistry(services).resolve('pi', 'anthropic/claude-opus-5.5')).resolves.toBeUndefined();
  });

  it('resolves an existing bare model when exactly one compatible service declares it', async () => {
    process.env.PROVIDER_TEST_KEY = 'private-provider-key';
    const registry = new ModelProviderRegistry(services);
    await expect(registry.resolve('pi', 'deepseek-flash')).resolves.toMatchObject({
      id: 'deepseek',
      model: expect.stringContaining('/deepseek-flash'),
    });
    await expect(registry.resolve('codex', 'deepseek-flash')).resolves.toMatchObject({
      id: 'deepseek',
      model: 'deepseek-flash',
    });
    await expect(registry.resolve('claude', 'deepseek-flash')).resolves.toBeUndefined();
  });

  it('rejects an ambiguous bare model instead of choosing a provider', async () => {
    process.env.PROVIDER_TEST_KEY = 'private-provider-key';
    const registry = new ModelProviderRegistry({
      ...services,
      second: { ...services.deepseek!, baseUrl: 'https://second.example/v1' },
    });
    await expect(registry.resolve('pi', 'deepseek-flash')).rejects.toThrow('多个 provider');
  });

  it('does not publish unconfigured native accounts as Providers', () => {
    expect(new ModelProviderRegistry().options('codex')).toEqual([]);
    expect(new ModelProviderRegistry().options('pi')).toEqual([]);
  });

  it('publishes Agent-filtered Provider choices and composes card selections', async () => {
    const options = new ModelProviderRegistry(services).options('pi');
    expect(options).toEqual([
      expect.objectContaining({ id: 'deepseek', defaultModel: 'deepseek-flash' }),
    ]);
    expect(selectedProvider(options, 'deepseek/deepseek-flash')?.id).toBe('deepseek');
    expect(selectedProvider(options, 'deepseek-flash')?.id).toBe('deepseek');
    expect(composeProviderSelection(options, 'deepseek', 'deepseek-flash')).toBe('deepseek/deepseek-flash');
    expect(composeProviderSelection(options, AUTO_MODEL_PROVIDER, 'native/model')).toBe('native/model');
  });
});
