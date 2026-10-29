import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelServiceCatalog } from '../../../src/model-service/catalog';
import { normalizeModelService } from '../../../src/model-service/config';
import { ModelProviderRegistry } from '../../../src/model-provider/provider';
import { parseAgyModels } from '../../../src/agent/agy/models';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('provider model discovery', () => {
  it('parses native agy catalog output without pinning model generations', () => {
    expect(parseAgyModels('Fetching available models...\nModel   Name\n\u001b[32mgemini-future-high\u001b[0m   Gemini Future (High)\ngemini-next\t\tGemini Next\n'))
      .toEqual([{ value: 'gemini-future-high', label: 'Gemini Future (High)' }, { value: 'gemini-next', label: 'Gemini Next' }]);
  });

  it('fetches only on picker refresh, preserves provider namespaces and reuses the bounded cache', async () => {
    vi.stubEnv('CATALOG_TEST_KEY', 'private-key');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'google/gemini-future' }, { id: 'bad model' },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const config = normalizeModelService({ protocol: 'responses', baseUrl: 'https://catalog.example/v1', model: 'default-model',
      apiKey: { source: 'env', id: 'CATALOG_TEST_KEY' },
      endpoints: { gemini: { baseUrl: 'https://catalog.example', model: 'google/gemini-future', contextWindow: 1048576 } } });
    const registry = new ModelProviderRegistry({ provider: config });
    expect(await modelServiceCatalog(config)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await registry.modelOptions('agy', true)).toContainEqual({ value: 'provider/google/gemini-future', label: 'provider · google/gemini-future' });
    expect(fetcher).toHaveBeenCalledWith('https://catalog.example/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer private-key' }, redirect: 'error', signal: expect.any(AbortSignal),
    }));
    await registry.modelOptions('agy');
    await registry.modelOptions('agy', true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses native Gemini catalog authentication and keeps a failed catalog advisory', async () => {
    vi.stubEnv('CATALOG_NATIVE_KEY', 'private-key');
    const fetcher = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const config = normalizeModelService({ protocol: 'gemini', baseUrl: 'https://native-catalog.example', model: 'gemini-future',
      apiKey: { source: 'env', id: 'CATALOG_NATIVE_KEY' }, contextWindow: 1048576 });
    expect(await modelServiceCatalog(config, true)).toEqual([]);
    expect(fetcher).toHaveBeenCalledWith('https://native-catalog.example/v1beta/models', expect.objectContaining({
      headers: { 'x-goog-api-key': 'private-key' },
    }));
    expect(await new ModelProviderRegistry({ native: config }).modelOptions('agy')).toEqual([
      { value: 'native/gemini-future', label: 'native · gemini-future' },
    ]);
  });
});
