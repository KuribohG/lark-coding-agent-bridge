import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { supportedModels, validateModelId, type ModelOption } from './models';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
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

export function parseEffort(value: unknown, agentKind: AgentKind): ReasoningEffort | undefined {
  if (value === undefined || value === '' || value === 'default') return undefined;
  if (typeof value !== 'string' || !REASONING_EFFORTS.includes(value as ReasoningEffort) ||
      (agentKind === 'claude' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(value))) {
    throw new Error(`不支持的思考强度：${String(value)}。`);
  }
  return value as ReasoningEffort;
}

export function availableEfforts(agentKind: AgentKind, model?: ModelOption): string[] {
  return model?.reasoningEfforts ?? (agentKind === 'claude'
    ? ['low', 'medium', 'high', 'xhigh', 'max'] : [...REASONING_EFFORTS]);
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

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Read local defaults/catalog only; never probe a provider or expose credentials. */
export async function readModelEnvironment(profile: ProfileConfig, profileDir: string): Promise<ModelEnvironment> {
  try {
    return await loadModelEnvironment(profile, profileDir);
  } catch {
    // Catalogs are advisory; a stale/unreadable cache must not block runs or
    // expose a parser error containing unrelated CLI configuration values.
    log.warn('model-settings', 'local-metadata-unavailable', { agentKind: profile.agentKind });
    return { defaults: {}, models: supportedModels(profile.agentKind) };
  }
}

async function loadModelEnvironment(profile: ProfileConfig, profileDir: string): Promise<ModelEnvironment> {
  const fallback = { defaults: {}, models: supportedModels(profile.agentKind) };
  if (profile.agentKind !== 'codex') {
    const text = await readOptional(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'));
    const settings = text ? JSON.parse(text) : {};
    const model = process.env.ANTHROPIC_MODEL ?? settings.model;
    return {
      ...fallback,
      defaults: {
        ...(typeof model === 'string' && model !== 'default' ? { model: validateModelId(model) } : {}),
        reasoningEffort: parseEffort(process.env.CLAUDE_CODE_EFFORT_LEVEL ?? settings.effortLevel, 'claude'),
      },
    };
  }
  const codex = profile.codex;
  const codexHome = codex?.codexHome ?? (codex?.inheritCodexHome !== false
    ? process.env.CODEX_HOME ?? join(homedir(), '.codex') : join(profileDir, 'codex-home'));
  const configPath = join(codexHome, 'config.toml');
  const text = codex?.ignoreUserConfig ? undefined : await readOptional(configPath);
  let config = (text ? parse(text) : {}) as Record<string, unknown>;
  if (typeof config.profile === 'string') {
    const profiles = config.profiles as Record<string, object> | undefined;
    const layer = await readOptional(join(codexHome, `${config.profile}.config.toml`));
    config = { ...config, ...(profiles?.[config.profile] ?? {}), ...(layer ? parse(layer) : {}) };
  }
  const defaults: ModelSettings = {
    ...(typeof config.model === 'string' ? { model: validateModelId(config.model) } : {}),
    reasoningEffort: parseEffort(config.model_reasoning_effort, 'codex'),
  };
  const catalogPath = typeof config.model_catalog_json === 'string'
    ? resolve(dirname(configPath), config.model_catalog_json.replace(/^~\//, `${homedir()}/`))
    : join(codexHome, 'models_cache.json');
  const catalogText = await readOptional(catalogPath);
  if (!catalogText) return { ...fallback, defaults };
  const catalog = JSON.parse(catalogText);
  const entries = Array.isArray(catalog) ? catalog : catalog.models;
  const models: ModelOption[] = [];
  if (Array.isArray(entries)) for (const entry of entries) {
    if (!entry || typeof entry.slug !== 'string') continue;
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((v: { effort?: string } | null) => v?.effort)
        .filter((v: string) => REASONING_EFFORTS.includes(v as ReasoningEffort)) : undefined;
    models.push({
      value: validateModelId(entry.slug),
      label: typeof entry.display_name === 'string' ? entry.display_name : entry.slug,
      reasoningEfforts: levels,
      defaultReasoningEffort: parseEffort(entry.default_reasoning_level, 'codex'),
    });
  }
  return { defaults, models: models.length ? [{ value: 'default', label: '跟随默认' }, ...models] : fallback.models };
}
