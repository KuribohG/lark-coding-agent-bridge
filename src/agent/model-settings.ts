import type { AgentKind } from '../config/profile-schema';
import type { ModelOption } from './models';
import { agentBackendSpec } from './backend-spec';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const EFFORT_RANK_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
/** Strongest tier. Claude maps it to ultracode (xhigh + standing workflow orchestration), offered only to workflow workers. */
export const ULTRA_EFFORT = 'ultra';
export interface ReasoningEffortOption {
  value: string;
  label: string;
}
export interface ModelSettings {
  model?: string;
  /** Model provider (a configured service name or `native`); independent of {@link model}. */
  provider?: string;
  reasoningEffort?: ReasoningEffort;
}
export interface ModelEnvironment {
  defaults: ModelSettings;
  models: ModelOption[];
}
export interface ResolvedModelSettings extends ModelSettings {
  modelSource: 'scope' | 'profile' | 'cli';
  providerSource: 'scope' | 'profile' | 'cli';
  effortSource: 'scope' | 'profile' | 'cli' | 'model';
  notice?: string;
}

export function parseEffort(value: unknown, agentKind: AgentKind, opts: { extended?: boolean } = {}): ReasoningEffort | undefined {
  if (value === undefined || value === '' || value === 'default') return undefined;
  if (typeof value !== 'string' || !(opts.extended ? extendedEfforts(agentKind) : availableEfforts(agentKind)).includes(value)) {
    throw new Error(`不支持的思考强度：${String(value)}。`);
  }
  return value as ReasoningEffort;
}

export function availableEfforts(agentKind: AgentKind, model?: ModelOption): string[] {
  return model?.reasoningEfforts ?? [...agentBackendSpec(agentKind).reasoningEfforts];
}

export function extendedEfforts(agentKind: AgentKind): string[] {
  const spec = agentBackendSpec(agentKind);
  return spec.extendedReasoningEfforts
    ? [...spec.extendedReasoningEfforts]
    : availableEfforts(agentKind);
}

/** Pick the highest-ranked reasoning effort from a supported list (or the agentKind's default list). */
export function highestEffort(efforts: readonly string[], agentKind?: AgentKind): string | undefined {
  const source = efforts.length > 0 ? efforts : (agentKind ? availableEfforts(agentKind) : []);
  const filtered = source
    .map((v) => String(v || '').trim())
    .filter((v) => v && v !== 'auto' && v !== 'default');
  if (!filtered.length) return undefined;
  let best: string | undefined;
  let bestRank = -1;
  for (const item of filtered) {
    const rank = (EFFORT_RANK_ORDER as readonly string[]).indexOf(item);
    if (rank > bestRank) {
      bestRank = rank;
      best = item;
    }
  }
  return best ?? filtered[filtered.length - 1];
}

/** Shared selector options for every chat-facing reasoning-effort setting. */
export function reasoningEffortOptions(agentKind: AgentKind, model?: ModelOption): ReasoningEffortOption[] {
  return [
    { value: 'default', label: '跟随上层默认' },
    ...availableEfforts(agentKind, model).map((value) => ({ value, label: value })),
  ];
}

/** Validate the combined settings; unknown provider models remain usable. */
export function resolveModelSettings(
  profile: ModelSettings,
  scope: ModelSettings,
  environment: ModelEnvironment,
): ResolvedModelSettings {
  const model = (scope.model === 'default' ? undefined : scope.model) ??
    (profile.model === 'default' ? undefined : profile.model) ?? environment.defaults.model;
  const reasoningEffort = scope.reasoningEffort ?? profile.reasoningEffort ?? environment.defaults.reasoningEffort;
  const provider = (scope.provider === 'default' ? undefined : scope.provider) ?? profile.provider;
  const result: ResolvedModelSettings = {
    model,
    ...(provider ? { provider } : {}),
    reasoningEffort,
    modelSource: scope.model && scope.model !== 'default' ? 'scope' : profile.model && profile.model !== 'default' ? 'profile' : 'cli',
    providerSource: scope.provider && scope.provider !== 'default' ? 'scope' : profile.provider ? 'profile' : 'cli',
    effortSource: scope.reasoningEffort ? 'scope' : profile.reasoningEffort ? 'profile' : 'cli',
  };
  const info = environment.models.find((m) => m.value === model);
  // Local metadata cannot resolve project/managed CLI settings. Only validate
  // combinations whose two values are explicitly controlled by the bridge.
  if (result.modelSource !== 'cli' && result.effortSource !== 'cli' &&
      reasoningEffort && info?.reasoningEfforts && !info.reasoningEfforts.includes(reasoningEffort)) {
    if (!info.defaultReasoningEffort || !info.reasoningEfforts.includes(info.defaultReasoningEffort)) {
      throw new Error(`模型 ${model} 不支持 ${reasoningEffort}；可用档位：${info.reasoningEfforts.join(', ')}。`);
    }
    result.reasoningEffort = info.defaultReasoningEffort as ReasoningEffort;
    result.effortSource = 'model';
    result.notice = `${model} 不支持 ${reasoningEffort}，本次使用模型默认 ${result.reasoningEffort}。`;
  }
  return result;
}

/** Omit inherited values so the CLI still applies project and managed defaults. */
export function modelRunArguments(settings: ResolvedModelSettings): ModelSettings {
  return {
    model: settings.modelSource === 'cli' ? undefined : settings.model,
    ...(settings.provider ? { provider: settings.provider } : {}),
    reasoningEffort: settings.effortSource === 'cli' ? undefined : settings.reasoningEffort,
  };
}
