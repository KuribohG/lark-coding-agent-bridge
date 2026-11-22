import { modelServiceCatalog } from '../model-service/catalog';
import type { ModelOption } from '../agent/models';
import { createHash } from 'node:crypto';
import { validateModelId } from '../agent/models';
import type { AgentKind } from '../config/profile-schema';
import {
  modelServiceEndpoint,
  type ModelProtocol,
  type ModelServiceConfig,
  type NormalizeModelServiceOptions,
} from '../model-service/config';
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
/** Explicit setting that keeps the Agent CLI on its own account and configuration. */
export const NATIVE_MODEL_PROVIDER = 'native';

/**
 * One run's model settings. The provider is chosen independently of the model
 * id: a model name never selects a provider on its own.
 */
export interface ModelProviderSelection {
  /** Model id forwarded to the backend verbatim. */
  model?: string;
  /** Configured service name, {@link NATIVE_MODEL_PROVIDER}, or unset for automatic selection. */
  provider?: string;
}

/** A model service that can be bound to one or more Agent CLIs. */
abstract class ModelProvider {
  constructor(
    readonly id: string,
    readonly displayName: string,
  ) {}

  abstract supports(agentKind: AgentKind): boolean;
  abstract bind(agentKind: AgentKind, model: string, credentials?: boolean): Promise<ResolvedModelProvider>;
  abstract models(agentKind: AgentKind, refresh: boolean): Promise<ModelOption[]>;
  defaultModel(_agentKind: AgentKind): string | undefined { return undefined; }

  protected assertSupported(agentKind: AgentKind): void {
    if (!this.supports(agentKind)) {
      throw new Error(`模型 provider「${this.displayName}」不支持 ${agentKind} agent`);
    }
  }
}

/** A named API service selects a native wire binding advertised by the backend. */
class ConfiguredModelProvider extends ModelProvider {
  constructor(
    id: string,
    private readonly config: ModelServiceConfig,
    private readonly serviceOptions?: NormalizeModelServiceOptions,
  ) {
    super(id, id);
  }

  supports(agentKind: AgentKind): boolean {
    return this.binding(agentKind) !== undefined;
  }

  override defaultModel(agentKind: AgentKind): string | undefined {
    return this.binding(agentKind)?.endpoint.model;
  }

  async bind(agentKind: AgentKind, model: string, credentials = true): Promise<ResolvedModelProvider> {
    this.assertSupported(agentKind);
    const modelId = validateModelId(model);
    const binding = this.binding(agentKind)!;
    const service = credentials
      ? await loadModelConnection(this.config, binding.protocol, modelId, this.serviceOptions)
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

/** Provider registry shared by Lark, Web and background runs. */
export class ModelProviderRegistry {
  private readonly providers: ModelProvider[];

  constructor(
    readonly services: Record<string, ModelServiceConfig> = {},
    options?: NormalizeModelServiceOptions,
  ) {
    const custom = Object.entries(services).map(([id, config]) => new ConfiguredModelProvider(id, config, options));
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

  /** Resolve a stored selection string; a `provider/model` override is still accepted. */
  async resolve(agentKind: AgentKind, selection: string | undefined, credentials = true): Promise<ResolvedModelProvider | undefined> {
    return this.resolveRun(agentKind, { model: selection }, credentials);
  }

  /**
   * Bind the provider for one run. The provider comes from the explicit setting
   * (`native` means "no binding"), otherwise from the sole service supporting
   * the backend; more than one candidate without a setting is an error rather
   * than a guess. The model id is forwarded verbatim.
   */
  async resolveRun(agentKind: AgentKind, selection: ModelProviderSelection = {}, credentials = true): Promise<ResolvedModelProvider | undefined> {
    const requested = selection.provider?.trim() || undefined;
    if (requested === NATIVE_MODEL_PROVIDER) return undefined;
    const rawModel = selection.model && selection.model !== 'default' ? selection.model : undefined;
    const prefixed = rawModel ? this.providers.find(candidate => rawModel.startsWith(`${candidate.id}/`)) : undefined;
    if (prefixed && !prefixed.supports(agentKind)) {
      throw new Error(`模型 provider「${prefixed.displayName}」不支持 ${agentKind} agent`);
    }
    if (requested && prefixed && prefixed.id !== requested) {
      throw new Error(`模型 ${rawModel} 属于 provider「${prefixed.id}」，与所选的「${requested}」不一致`);
    }
    const provider = requested
      ? this.requireProvider(agentKind, requested)
      : prefixed ?? this.soleProvider(agentKind);
    if (!provider) return undefined;
    const model = prefixed ? rawModel!.slice(prefixed.id.length + 1) : rawModel;
    const modelId = model ?? provider.defaultModel(agentKind);
    if (!modelId) throw new Error(`Provider「${provider.displayName}」没有默认模型，请填写模型 ID`);
    return provider.bind(agentKind, modelId, credentials);
  }

  /** The backend-bound service when there is exactly one; ambiguity is an error, not a guess. */
  private soleProvider(agentKind: AgentKind): ModelProvider | undefined {
    const providers = this.providers.filter(candidate => candidate.supports(agentKind));
    if (providers.length > 1) {
      throw new Error(`该 agent 有多个模型 Provider（${providers.map(candidate => candidate.id).join(', ')}），请在 run.provider 中指定，或设置 provider = "${NATIVE_MODEL_PROVIDER}"`);
    }
    return providers[0];
  }

  private requireProvider(agentKind: AgentKind, id: string): ModelProvider {
    const provider = this.providers.find(candidate => candidate.id === id);
    if (!provider) throw new Error(`未知模型 Provider：${id}`);
    if (!provider.supports(agentKind)) throw new Error(`模型 provider「${id}」不支持 ${agentKind} agent`);
    return provider;
  }

  /** A run without a model selection still binds the sole backend service. */
  async resolveDefault(agentKind: AgentKind, credentials = true): Promise<ResolvedModelProvider | undefined> {
    return this.resolveRun(agentKind, {}, credentials);
  }

  async resolveStartup(agentKind: AgentKind, model?: string, providerId?: string): Promise<ResolvedModelProvider | undefined> {
    return this.resolveRun(agentKind, { model, provider: providerId });
  }
}

/** Provider option implied by an explicit setting or a legacy `provider/model` selection. */
export function providerForSelection(
  options: readonly ModelProviderOption[],
  settings: { model?: string; provider?: string },
): ModelProviderOption | undefined {
  if (settings.provider === NATIVE_MODEL_PROVIDER) return undefined;
  if (settings.provider) return options.find(option => option.id === settings.provider);
  const model = settings.model;
  if (!model || model === 'default') return undefined;
  return options.find(option => model.startsWith(`${option.id}/`));
}

function stableSuffix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12).toUpperCase();
}
