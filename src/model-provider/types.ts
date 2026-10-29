export interface PiProviderRegistration {
  providerId: string;
  name: string;
  baseUrl: string;
  api: 'openai-responses';
  apiKeyEnv: string;
  headers?: Record<string, string>;
  model: {
    id: string;
    name: string;
    api: 'openai-responses';
    reasoning: boolean;
    input: Array<'text' | 'image'>;
    contextWindow: number;
    maxTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    thinkingLevelMap?: Record<string, string | null>;
  };
}

export interface CodexProviderRegistration {
  providerId: string;
  name: string;
  baseUrl: string;
  wireApi: 'responses';
  apiKeyEnv: string;
  headersEnv?: Record<string, string>;
}

/**
 * Agent-neutral provider selection resolved into backend-specific connection
 * data. Credentials live only in `env`; generated extension/config text uses
 * environment-variable names so secrets never reach argv or disk.
 */
export interface ResolvedModelProvider {
  id: string;
  displayName: string;
  model: string;
  env?: NodeJS.ProcessEnv;
  pi?: PiProviderRegistration;
  codex?: CodexProviderRegistration;
  agy?: AgyProviderRegistration;
}

export interface AgyProviderRegistration {
  baseUrl: string;
  apiKeyEnv: string;
  modelKey: string;
  contextWindow: number;
}

export interface ProviderBindingInput {
  providerId: string;
  contextWindow?: number;
  id: string;
  displayName: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  headersEnv: Record<string, string>;
  env: NodeJS.ProcessEnv;
}
