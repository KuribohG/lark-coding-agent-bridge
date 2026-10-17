import type { ProfileConfig } from '../config/profile-schema';
import { loadCodexModelService } from './codex/model-service';

/** Direct model calls are distinct from a tool-capable AgentAdapter run. */
export interface ResponsesModelService { url: string; model: string; key: string; headers?: Record<string, string> }

export async function loadProfileModelService(profile: ProfileConfig, modelOverride?: string): Promise<ResponsesModelService> {
  if (profile.agentKind !== 'codex') throw new Error('当前 profile 尚未接入 Responses 模型服务');
  return loadCodexModelService(profile, modelOverride);
}
