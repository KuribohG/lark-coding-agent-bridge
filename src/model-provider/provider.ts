import { modelServiceCatalog } from '../model-service/catalog';
import type { ModelOption } from '../agent/models';
import { createHash } from 'node:crypto';
import { validateModelId } from '../agent/models';
import type { AgentKind } from '../config/profile-schema';
import { modelServiceEndpoint, type ModelProtocol, type ModelServiceConfig } from '../model-service/config';
import { loadModelConnection } from '../model-service/service';
import { agentBackendSpec } from '../agent/backend-spec';

export type { ResolvedModelProvider, PiProviderRegistration, CodexProviderRegistration } from './types';
import type { ResolvedModelProvider } from './types';
import { bindModelProvider } from './bindings';
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
  abstract bind(agentKind: AgentKind, model: string, credentials?: boolean): Promise<ResolvedModelProvider>;
  abstract models(agentKind: AgentKind, refresh: boolean): Promise<ModelOption[]>;
  /** Bare model IDs this provider may resolve when no provider prefix is used. */
  bareModels(_agentKind: AgentKind): readonly string[] { return []; }
  defaultModel(_agentKind: AgentKind): string | undefined { return undefined; }

  protected assertSupported(agentKind: AgentKind): void {
    if (!this.supports(agentKind)) {
      throw new Error(`模型 provider「${this.displayName}」不支持 ${agentKind} agent`);
    }
  }
}

/** A named API service selects a native wire binding advertised by the backend. */
class ConfiguredModelProvider extends ModelProvider {
  constructor(id: string, private readonly config: ModelServiceConfig) {
    super(id, id);
  }

  supports(agentKind: AgentKind): boolean {
    return this.binding(agentKind) !== undefined;
  }

  override bareModels(agentKind: AgentKind): readonly string[] {
    return this.supports(agentKind) ? [this.binding(agentKind)!.endpoint.model] : [];
  }

  override defaultModel(agentKind: AgentKind): string | undefined {
    return this.binding(agentKind)?.endpoint.model;
  }

  async bind(agentKind: AgentKind, model: string, credentials = true): Promise<ResolvedModelProvider> {
    this.assertSupported(agentKind);
    const modelId = validateModelId(model);
    const binding = this.binding(agentKind)!;
    const service = credentials
      ? await loadModelConnection(this.config, binding.protocol, modelId)
      : { baseUrl: binding.endpoint.baseUrl, key: '', contextWindow: binding.endpoint.contextWindow, headers: {} as Record<string, string> };
    const suffix = stableSuffix(`${this.id}\0${modelId}`);
    const env: NodeJS.ProcessEnv = credentials ? {
      [`LARK_MODEL_PROVIDER_KEY_${suffix}`]: service.key,
    } : {};
    const headersEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(service.headers ?? {})) {
      const envName = `LARK_MODEL_PROVIDER_HEADER_${stableSuffix(`${this.id}\0${name}`)}`;
      env[envName] = value;
      headersEnv[name] = envName;
    }

    return bindModelProvider(binding.type, {
      providerId: `lark_${this.id.replace(/[^a-zA-Z0-9_]/g, '_')}_${suffix.toLowerCase()}`,
      id: this.id, displayName: this.displayName, model: modelId,
      baseUrl: service.baseUrl, apiKeyEnv: `LARK_MODEL_PROVIDER_KEY_${suffix}`, headersEnv, env,
      contextWindow: service.contextWindow,
    });
  }

  async models(agentKind: AgentKind, refresh: boolean): Promise<ModelOption[]> {
    const binding = this.binding(agentKind);
    if (!binding) return [];
    const catalog = await modelServiceCatalog(this.config, refresh);
    const models = new Map<string, ModelOption>();
    for (const model of [{ id: binding.endpoint.model, label: binding.endpoint.model }, ...catalog]) {
      const value = `${this.id}/${model.id}`;
      models.set(value, { value, label: `${this.displayName} · ${model.label}` });
    }
    return [...models.values()];
  }

  private binding(agentKind: AgentKind) {
    for (const [protocol, type] of Object.entries(agentBackendSpec(agentKind).providerBindings)) {
      const endpoint = modelServiceEndpoint(this.config, protocol as ModelProtocol);
      if (endpoint) return { protocol: protocol as ModelProtocol, type, endpoint };
    }
    return undefined;
  }
}

/** Provider registry shared by Lark, Web, background and timed runs. */
export class ModelProviderRegistry {
  private readonly providers: ModelProvider[];

  constructor(services: Record<string, ModelServiceConfig> = {}) {
    const custom = Object.entries(services).map(([id, config]) => new ConfiguredModelProvider(id, config));
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

  async modelOptions(agentKind: AgentKind, refresh = false): Promise<ModelOption[]> {
    const catalogs = await Promise.all(this.providers.map(provider => provider.models(agentKind, refresh)));
    return catalogs.flat();
  }

  async resolve(agentKind: AgentKind, selection: string | undefined, credentials = true): Promise<ResolvedModelProvider | undefined> {
    if (!selection || selection === 'default') return undefined;
    const provider = this.providers.find(candidate => selection.startsWith(`${candidate.id}/`));
    if (provider) {
      const model = selection.slice(provider.id.length + 1);
      if (!model) throw new Error(`模型选择 ${selection} 缺少模型 ID`);
      return provider.bind(agentKind, model, credentials);
    }
    const bare = this.providers.filter(candidate => candidate.bareModels(agentKind).includes(selection));
    if (bare.length > 1) {
      throw new Error(`模型 ${selection} 同时由多个 provider 提供，请使用 provider/model 明确选择`);
    }
    return bare[0]?.bind(agentKind, selection, credentials);
  }

  async resolveStartup(agentKind: AgentKind, model?: string, providerId?: string): Promise<ResolvedModelProvider | undefined> {
    const options = this.options(agentKind);
    const selected = providerId ? options.find(option => option.id === providerId) : selectedProvider(options, model);
    if (providerId && !selected) throw new Error(`未知模型 Provider：${providerId}`);
    const provider = selected ?? (options.length === 1 ? options[0] : undefined);
    if (!provider && options.length > 1) throw new Error('请在 launch.provider 中选择启动时使用的模型 Provider。');
    if (!provider) return undefined;
    const modelProvider = selectedProvider(options, model);
    const localModel = modelProvider && modelProvider.id !== provider.id ? provider.defaultModel
      : model?.startsWith(`${provider.id}/`) ? model.slice(provider.id.length + 1) : model;
    return this.resolve(agentKind, `${provider.id}/${localModel && localModel !== 'default' ? localModel : provider.defaultModel}`);
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

function stableSuffix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12).toUpperCase();
}
