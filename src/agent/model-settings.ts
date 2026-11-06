import type { AgentKind } from '../config/profile-schema';
import type { ModelOption } from './models';
import { agentBackendSpec } from './backend-spec';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
/** Strongest tier. Claude maps it to ultracode (xhigh + standing workflow orchestration), offered only to deadline-bounded runs. */
export const ULTRA_EFFORT = 'ultra';
export interface ReasoningEffortOption {
  value: string;
  label: string;
}
export interface ModelSettings {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}
export interface ModelEnvironment {
  defaults: ModelSettings;
  models: ModelOption[];
}
export interface ResolvedModelSettings extends ModelSettings {
  modelSource: 'scope' | 'profile' | 'cli';
  effortSource: 'scope' | 'profile' | 'cli' | 'model';
  notice?: string;
}

export function parseEffort(value: unknown, agentKind: AgentKind, opts: { timedRun?: boolean } = {}): ReasoningEffort | undefined {
  if (value === undefined || value === '' || value === 'default') return undefined;
  if (typeof value !== 'string' || !(opts.timedRun ? timedRunEfforts(agentKind) : availableEfforts(agentKind)).includes(value)) {
    throw new Error(`不支持的思考强度：${String(value)}。`);
  }
  return value as ReasoningEffort;
}

export function availableEfforts(agentKind: AgentKind, model?: ModelOption): string[] {
  return model?.reasoningEfforts ?? [...agentBackendSpec(agentKind).reasoningEfforts];
}

export function timedRunEfforts(agentKind: AgentKind): string[] {
  const spec = agentBackendSpec(agentKind);
  return spec.timedRunReasoningEfforts
    ? [...spec.timedRunReasoningEfforts]
    : availableEfforts(agentKind);
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
  const result: ResolvedModelSettings = {
    model,
    reasoningEffort,
    modelSource: scope.model && scope.model !== 'default' ? 'scope' : profile.model && profile.model !== 'default' ? 'profile' : 'cli',
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
    reasoningEffort: settings.effortSource === 'cli' ? undefined : settings.reasoningEffort,
  };
}
