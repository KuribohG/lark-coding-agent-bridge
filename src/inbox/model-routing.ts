import { loadProfileModelService, supportsProfileModelService } from '../agent/model-service';
import type { ProfileConfig } from '../config/profile-schema';
import { INBOX_ANALYSIS_MODEL } from './analyzer';
import type { InboxConfig } from './config';

export function inboxTriageProfile(config: InboxConfig, profiles: Record<string, ProfileConfig>): ProfileConfig {
  const profile = profiles[config.triageProfile || config.executorProfile];
  if (!profile || profile.mode === 'team' || !supportsProfileModelService(profile)) {
    throw new Error('请选择提供 Responses 模型服务的个人筛选 profile；Claude 可执行深入分析，筛选需单独选择模型服务');
  }
  return profile;
}

export function loadInboxTriageModel(config: InboxConfig, profile: ProfileConfig, profileDir?: string) {
  const separate = config.triageProfile && config.triageProfile !== config.executorProfile;
  return loadProfileModelService(profile, config.triageModel ?? (separate ? INBOX_ANALYSIS_MODEL : config.analysisModel ?? INBOX_ANALYSIS_MODEL), profileDir);
}
