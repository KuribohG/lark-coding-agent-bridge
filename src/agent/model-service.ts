import type { ProfileConfig } from '../config/profile-schema';
import { loadCodexModelService } from './codex/model-service';
import { agentBackendSpec } from './backend-spec';

/** Direct model calls are distinct from a tool-capable AgentAdapter run. */
export type { ResponsesModelService } from '../model-service/service';
import type { ResponsesModelService } from '../model-service/service';

export function supportsProfileModelService(profile: ProfileConfig): boolean {
  return agentBackendSpec(profile.agentKind).supportsProfileResponsesService;
}

export async function loadProfileModelService(profile: ProfileConfig, modelOverride?: string, profileDir?: string): Promise<ResponsesModelService> {
  if (!supportsProfileModelService(profile)) throw new Error('当前 profile 尚未接入 Responses 模型服务');
  return loadCodexModelService(profile, modelOverride, profileDir);
}
