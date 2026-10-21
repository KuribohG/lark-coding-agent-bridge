import { afterEach, describe, expect, it } from 'vitest';
import { ModelProviderRegistry } from '../../../src/model-provider/provider';
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

  it('routes the official GPT account through native Pi and Codex authentication', async () => {
    const registry = new ModelProviderRegistry();
    await expect(registry.resolve('pi', 'openai-codex/gpt-6.1-sol')).resolves.toMatchObject({
      id: 'openai-codex',
      model: 'openai-codex/gpt-6.1-sol',
    });
    await expect(registry.resolve('codex', 'openai-codex/gpt-6.1-sol')).resolves.toMatchObject({
      id: 'openai-codex',
      model: 'gpt-6.1-sol',
      codex: { providerId: 'openai', auth: 'native' },
    });
    await expect(registry.resolve('claude', 'openai-codex/gpt-6.1-sol')).rejects.toThrow('不支持 claude');
  });

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
        auth: 'api-key',
        baseUrl: 'https://gateway.example/v1',
        wireApi: 'responses',
      },
    });
    expect(resolved?.codex?.auth).toBe('api-key');
    if (resolved?.codex?.auth !== 'api-key') throw new Error('expected api-key provider');
    expect(resolved.codex.apiKeyEnv).toMatch(/^LARK_MODEL_PROVIDER_KEY_[A-F0-9]+$/);
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

  it('reserves the native provider id', () => {
    expect(() => new ModelProviderRegistry({
      'openai-codex': services.deepseek!,
    })).toThrow('保留');
  });
});
