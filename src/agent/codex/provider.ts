import type { ProviderBindingInput, ResolvedModelProvider } from '../../model-provider/types';

export function bindCodexProvider(input: ProviderBindingInput): ResolvedModelProvider {
  return { id: input.id, displayName: input.displayName, model: input.model, env: input.env,
    codex: { providerId: input.providerId, name: input.displayName, baseUrl: input.baseUrl,
      wireApi: 'responses', apiKeyEnv: input.apiKeyEnv,
      ...(Object.keys(input.headersEnv).length ? { headersEnv: input.headersEnv } : {}) } };
}
