import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProviderRegistry } from '../../../src/model-provider/provider';
import { normalizeModelService } from '../../../src/model-service/config';
import { loadModelService } from '../../../src/model-service/service';
import { agyProviderLaunch } from '../../../src/agent/agy/provider';

afterEach(() => vi.unstubAllEnvs());
const service = {
  protocol: 'responses', baseUrl: 'https://gateway.example/v1', model: 'reasoning-model',
  apiKey: { source: 'env', id: 'TEST_NATIVE_PROVIDER_KEY' },
  endpoints: { gemini: { baseUrl: 'https://gateway.example', model: 'google/gemini-next', contextWindow: 1048576 } },
};

describe('native provider bindings', () => {
  it('keeps one provider name and credential reference while selecting backend-specific protocols and models', async () => {
    vi.stubEnv('TEST_NATIVE_PROVIDER_KEY', 'private-provider-key');
    const config = normalizeModelService(service);
    const registry = new ModelProviderRegistry({ gateway: config });
    expect(registry.options('agy')).toEqual([{ id: 'gateway', label: 'gateway', defaultModel: 'google/gemini-next' }]);
    expect(registry.options('codex')[0]?.defaultModel).toBe('reasoning-model');
    const provider = await registry.resolve('agy', 'gateway/google/gemini-next');
    const launch = agyProviderLaunch(provider!);
    expect(launch.env.GOOGLE_GEMINI_BASE_URL).toBe('https://gateway.example');
    expect(launch.env.GEMINI_API_KEY).toBe('private-provider-key');
    expect(launch.env.AGY_ADC_AUTH).toBeUndefined();
    expect(JSON.stringify(launch.settings)).not.toContain('private-provider-key');
    expect(launch.settings.customModelsConfig.customModels[launch.model]?.modelName).toBe('gemini-api://google/gemini-next');
    expect(launch.settings.modelProvider).toBe('gemini');
    expect((await registry.resolve('codex', 'gateway/reasoning-model'))?.codex?.baseUrl).toBe('https://gateway.example/v1');
    expect((await loadModelService(config)).url).toBe('https://gateway.example/v1/responses');
  });

  it('does not infer a Gemini route from a Responses URL or silently drop headers', async () => {
    vi.stubEnv('TEST_NATIVE_PROVIDER_KEY', 'private-provider-key');
    const onlyResponses = normalizeModelService({ ...service, endpoints: undefined });
    const registry = new ModelProviderRegistry({ gateway: onlyResponses });
    expect(registry.options('agy')).toEqual([]);
    await expect(registry.resolve('agy', 'gateway/google/gemini-next')).rejects.toThrow('不支持');
    const withHeaders = new ModelProviderRegistry({ gateway: normalizeModelService({ ...service,
      headers: { 'X-Tenant': { source: 'env', id: 'TEST_NATIVE_PROVIDER_KEY' } } }) });
    await expect(withHeaders.resolve('agy', 'gateway/google/gemini-next')).rejects.toThrow('custom request headers');
  });

  it('validates additional endpoint URLs and keeps Gemini-only services out of Responses calls', async () => {
    expect(() => normalizeModelService({ ...service, endpoints: { gemini: { baseUrl: 'https://user:secret@gateway.example' } } })).toThrow('不含凭据');
    const gemini = normalizeModelService({ ...service, protocol: 'gemini', baseUrl: 'https://gateway.example', endpoints: undefined });
    await expect(loadModelService(gemini)).rejects.toThrow('responses');
  });
});
