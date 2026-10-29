import type { ProviderBindingInput, ResolvedModelProvider, PiProviderRegistration } from '../../model-provider/types';

export function bindPiProvider(input: ProviderBindingInput): ResolvedModelProvider {
  const providerId = input.providerId;
  return { id: input.id, displayName: input.displayName, model: `${providerId}/${input.model}`, env: input.env,
    pi: { providerId, name: input.displayName, baseUrl: input.baseUrl, api: 'openai-responses',
      apiKeyEnv: input.apiKeyEnv,
      ...(Object.keys(input.headersEnv).length ? { headers: input.headersEnv } : {}),
      model: providerModel(input.model) } };
}

function providerModel(id: string): PiProviderRegistration['model'] {
  if (id.startsWith('deepseek')) {
    return {
      id,
      name: id === 'deepseek-flash' ? 'DeepSeek-Flash' : id,
      api: 'openai-responses',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      cost: {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.006,
        cacheWrite: 0,
      },
      thinkingLevelMap: {
        off: null,
        minimal: 'low',
        low: 'low',
        medium: 'high',
        high: 'high',
        xhigh: 'max',
        max: 'max',
      },
    };
  }
  return {
    id,
    name: id,
    api: 'openai-responses',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}
