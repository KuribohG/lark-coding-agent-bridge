import { modelRunArguments, readModelEnvironment, resolveModelSettings, type ModelSettings, type ReasoningEffort } from '../agent/model-settings';
import type { ProfileConfig } from '../config/profile-schema';

/** Preserve the legacy Codex cost policy; other executors inherit their own defaults. */
export async function backgroundModelSettings(profile: ProfileConfig, profileDir: string, model?: string, reasoningEffort?: ReasoningEffort): Promise<ModelSettings> {
  const legacyCodex = model === undefined && profile.agentKind === 'codex';
  return modelRunArguments(resolveModelSettings(profile.preferences, {
    model: legacyCodex ? 'deepseek-flash' : model || undefined,
    reasoningEffort: reasoningEffort ?? (legacyCodex ? 'max' : undefined),
  }, await readModelEnvironment(profile, profileDir)));
}
