import { createHash } from 'node:crypto';
import { validateModelId } from '../agent/models';
import type { AgentKind } from '../config/profile-schema';
import type { ModelServiceConfig } from '../model-service/config';
import { loadModelService } from '../model-service/service';
import { agentBackendSpec } from '../agent/backend-spec';

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
}

export interface ModelProviderOption {
  id: string;
  label: string;
  defaultModel?: string;
}

export const AUTO_MODEL_PROVIDER = '__auto__';

/** A model service that can be bound to one or more Agent CLIs. */
abstract class ModelProvider {
  constructor(
    readonly id: string,
    readonly displayName: string,
  ) {}

  abstract supports(agentKind: AgentKind): boolean;
  abstract bind(agentKind: AgentKind, model: string): Promise<ResolvedModelProvider>;
  /** Bare model IDs this provider may resolve when no provider prefix is used. */
  bareModels(_agentKind: AgentKind): readonly string[] { return []; }
  defaultModel(_agentKind: AgentKind): string | undefined { return undefined; }

  protected assertSupported(agentKind: AgentKind): void {
    if (!this.supports(agentKind)) {
      throw new Error(`模型 provider「${this.displayName}」不支持 ${agentKind} agent`);
    }
  }
}

/** An existing Responses model service exposed to Pi and Codex agent runs. */
class ResponsesModelProvider extends ModelProvider {
  constructor(id: string, private readonly config: ModelServiceConfig) {
    super(id, id);
  }

  supports(agentKind: AgentKind): boolean {
    return agentBackendSpec(agentKind).supportsResponsesProvider;
  }

  override bareModels(agentKind: AgentKind): readonly string[] {
    return this.supports(agentKind) ? [this.config.model] : [];
  }

  override defaultModel(agentKind: AgentKind): string | undefined {
    return this.supports(agentKind) ? this.config.model : undefined;
  }

  async bind(agentKind: AgentKind, model: string): Promise<ResolvedModelProvider> {
    this.assertSupported(agentKind);
    const modelId = validateModelId(model);
    const service = await loadModelService(this.config, modelId);
    const suffix = stableSuffix(`${this.id}\0${modelId}`);
    const env: NodeJS.ProcessEnv = {
      [`LARK_MODEL_PROVIDER_KEY_${suffix}`]: service.key,
    };
    const headersEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(service.headers ?? {})) {
      const envName = `LARK_MODEL_PROVIDER_HEADER_${stableSuffix(`${this.id}\0${name}`)}`;
      env[envName] = value;
      headersEnv[name] = envName;
    }

    const binding = agentBackendSpec(agentKind).responsesBinding;
    if (binding === 'pi-extension') {
      const providerId = `lark_${this.id.replace(/[^a-zA-Z0-9_]/g, '_')}_${suffix.toLowerCase()}`;
      return {
        id: this.id,
        displayName: this.displayName,
        model: `${providerId}/${modelId}`,
        env,
        pi: {
          providerId,
          name: this.displayName,
          baseUrl: this.config.baseUrl,
          api: 'openai-responses',
          apiKeyEnv: `LARK_MODEL_PROVIDER_KEY_${suffix}`,
          ...(Object.keys(headersEnv).length > 0 ? { headers: headersEnv } : {}),
          model: providerModel(modelId),
        },
      };
    }
    if (binding !== 'codex-config') {
      throw new Error(`${agentKind} agent 没有 Responses provider 绑定方式`);
    }

    const providerId = `lark_${this.id.replace(/[^a-zA-Z0-9_]/g, '_')}_${suffix.toLowerCase()}`;
    return {
      id: this.id,
      displayName: this.displayName,
      model: modelId,
      env,
      codex: {
        providerId,
        name: this.displayName,
        baseUrl: this.config.baseUrl,
        wireApi: 'responses',
        apiKeyEnv: `LARK_MODEL_PROVIDER_KEY_${suffix}`,
        ...(Object.keys(headersEnv).length > 0 ? { headersEnv } : {}),
      },
    };
  }
}

/** Provider registry shared by Lark, Web, background and timed runs. */
export class ModelProviderRegistry {
  private readonly providers: ModelProvider[];

  constructor(services: Record<string, ModelServiceConfig> = {}) {
    const custom = Object.entries(services).map(([id, config]) => new ResponsesModelProvider(id, config));
    this.providers = custom
      .sort((left, right) => right.id.length - left.id.length);
  }

  list(): ReadonlyArray<Pick<ModelProvider, 'id' | 'displayName'>> {
    return this.providers.map(({ id, displayName }) => ({ id, displayName }));
  }

  options(agentKind: AgentKind): ModelProviderOption[] {
    return this.providers
      .filter(provider => provider.supports(agentKind))
      .map(provider => ({
        id: provider.id,
        label: provider.displayName,
        ...(provider.defaultModel(agentKind) ? { defaultModel: provider.defaultModel(agentKind) } : {}),
      }));
  }

  async resolve(agentKind: AgentKind, selection: string | undefined): Promise<ResolvedModelProvider | undefined> {
    if (!selection || selection === 'default') return undefined;
    const provider = this.providers.find(candidate => selection.startsWith(`${candidate.id}/`));
    if (provider) {
      const model = selection.slice(provider.id.length + 1);
      if (!model) throw new Error(`模型选择 ${selection} 缺少模型 ID`);
      return provider.bind(agentKind, model);
    }
    const bare = this.providers.filter(candidate => candidate.bareModels(agentKind).includes(selection));
    if (bare.length > 1) {
      throw new Error(`模型 ${selection} 同时由多个 provider 提供，请使用 provider/model 明确选择`);
    }
    return bare[0]?.bind(agentKind, selection);
  }
}

/** Split a model selection into a registered provider and its local model id. */
export function selectedProvider(
  options: readonly ModelProviderOption[],
  model: string | undefined,
): ModelProviderOption | undefined {
  if (!model || model === 'default') return undefined;
  const prefixed = options.find(option => model.startsWith(`${option.id}/`));
  if (prefixed) return prefixed;
  const defaults = options.filter(option => option.defaultModel === model);
  return defaults.length === 1 ? defaults[0] : undefined;
}

/** Compose the provider-qualified selection consumed by the shared runtime. */
export function composeProviderSelection(
  options: readonly ModelProviderOption[],
  providerId: string,
  model: string | undefined,
): string | undefined {
  if (!providerId || providerId === AUTO_MODEL_PROVIDER) return model;
  const option = options.find(candidate => candidate.id === providerId);
  if (!option) throw new Error(`未知模型 Provider：${providerId}`);
  const requested = model && model !== 'default' ? model : option.defaultModel;
  if (!requested) throw new Error(`Provider ${option.label} 没有默认模型，请填写模型 ID`);
  const existing = options.find(candidate => requested.startsWith(`${candidate.id}/`));
  const modelId = existing ? requested.slice(existing.id.length + 1) : requested;
  if (!modelId) throw new Error(`Provider ${option.label} 缺少模型 ID`);
  return `${option.id}/${modelId}`;
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

function stableSuffix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12).toUpperCase();
}
