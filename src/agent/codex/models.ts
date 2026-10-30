import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import type { ProfileConfig } from '../../config/profile-schema';
import { readOptional } from '../model-files';
import { parseEffort, REASONING_EFFORTS, type ReasoningEffort, type ModelSettings, type ModelEnvironment } from '../model-settings';
import { supportedModels, validateModelId, type ModelOption } from '../models';

export async function readCodexModels(profile: ProfileConfig, profileDir: string): Promise<ModelEnvironment> {
  const fallback = { defaults: {}, models: supportedModels('codex') };
  const codex = profile.codex;
  const codexHome = codex?.codexHome ?? (codex?.inheritCodexHome === true
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
    if (!entry || typeof entry.slug !== 'string' || entry.visibility === 'hide') continue;
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
