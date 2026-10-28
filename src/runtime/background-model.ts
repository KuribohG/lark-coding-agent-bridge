import { modelRunArguments, readModelEnvironment, resolveModelSettings, type ModelSettings, type ReasoningEffort } from '../agent/model-settings';
import { agentBackendSpec } from '../agent/backend-spec';
import type { ProfileConfig } from '../config/profile-schema';

/** Apply backend-owned background defaults without branching on agent names. */
export async function backgroundModelSettings(profile: ProfileConfig, profileDir: string, model?: string, reasoningEffort?: ReasoningEffort): Promise<ModelSettings> {
  const defaults = model === undefined
    ? agentBackendSpec(profile.agentKind).backgroundDefaults
    : undefined;
  return modelRunArguments(resolveModelSettings(profile.preferences, {
    model: defaults?.model ?? (model || undefined),
    reasoningEffort: reasoningEffort ?? defaults?.reasoningEffort as ReasoningEffort | undefined,
  }, await readModelEnvironment(profile, profileDir)));
}
