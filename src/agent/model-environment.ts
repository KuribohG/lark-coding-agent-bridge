import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { supportedModels } from './models';
import type { ModelEnvironment } from './model-settings';
import { readClaudeModels } from './claude/models';
import { readCodexModels } from './codex/models';
import { readAgyModels } from './agy/models';

const READERS: Record<AgentKind, (profile: ProfileConfig, profileDir: string) => Promise<ModelEnvironment>> = {
  claude: readClaudeModels,
  codex: readCodexModels,
  pi: async () => ({ defaults: {}, models: supportedModels('pi') }),
  agy: readAgyModels,
};

/** Metadata is advisory; unavailable native catalogs must never block a run. */
export async function readModelEnvironment(profile: ProfileConfig, profileDir: string): Promise<ModelEnvironment> {
  try {
    return await READERS[profile.agentKind](profile, profileDir);
  } catch {
    log.warn('model-settings', 'local-metadata-unavailable', { agentKind: profile.agentKind });
    return { defaults: {}, models: supportedModels(profile.agentKind) };
  }
}
