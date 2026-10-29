import type { ProviderBindingInput, ResolvedModelProvider } from '../../model-provider/types';

export function bindAgyProvider(input: ProviderBindingInput): ResolvedModelProvider {
  if (!input.contextWindow) throw new Error('Antigravity custom models require an explicit contextWindow on the Gemini endpoint');
  if (Object.keys(input.headersEnv).length) {
    throw new Error('Antigravity native Gemini provider does not support custom request headers');
  }
  return { id: input.id, displayName: input.displayName, model: input.model, env: input.env,
    agy: { baseUrl: input.baseUrl, apiKeyEnv: input.apiKeyEnv, modelKey: input.providerId, contextWindow: input.contextWindow } };
}

export function agyProviderLaunch(provider: ResolvedModelProvider) {
  const binding = provider.agy;
  if (!binding) throw new Error('The selected provider has no Antigravity binding');
  const key = provider.env?.[binding.apiKeyEnv];
  if (!key) throw new Error('Antigravity provider API key is unavailable');
  return {
    model: binding.modelKey,
    env: { ...provider.env, GEMINI_API_KEY: key, GOOGLE_GEMINI_BASE_URL: binding.baseUrl, AGY_ADC_AUTH: undefined },
    settings: {
      modelProvider: 'gemini',
      customModelsConfig: { customModels: {
        [binding.modelKey]: {
          // With a base-URL override, agy 1.4.10 uses the URI tail as the API model ID.
          modelName: `gemini-api://${provider.model}`,
          label: `${provider.displayName}/${provider.model}`,
          maxTokens: binding.contextWindow,
        },
      } },
    },
  };
}
