import { loadProfileModelService, supportsProfileModelService } from '../agent/model-service';
import type { ProfileConfig, RootConfig } from '../config/profile-schema';
import { resolveAppPaths } from '../config/app-paths';
import { modelServiceName, normalizeModelService, type ModelServiceConfig } from '../model-service/config';
import { loadModelService } from '../model-service/service';
import { INBOX_ANALYSIS_MODEL } from './analyzer';
import type { InboxConfig } from './config';

export type InboxTriageSource = { kind: 'service'; config: ModelServiceConfig }
  | { kind: 'legacy'; profile: ProfileConfig; profileName: string };

export function inboxTriageSource(config: InboxConfig, root: Pick<RootConfig, 'profiles' | 'modelServices'>): InboxTriageSource {
  if (config.triageService) {
    const name = modelServiceName(config.triageService);
    const service = root.modelServices?.[name];
    if (!service) throw new Error('找不到所选筛选模型服务，请在模型 API 服务中配置');
    return { kind: 'service', config: normalizeModelService(service) };
  }
  return { kind: 'legacy', profile: inboxTriageProfile(config, root.profiles), profileName: config.triageProfile || config.executorProfile };
}

export function loadInboxTriageSource(config: InboxConfig, source: InboxTriageSource, rootDir?: string) {
  if (source.kind === 'service') return loadModelService(source.config, config.triageModel);
  return loadInboxTriageModel(config, source.profile, resolveAppPaths({ rootDir, profile: source.profileName }).profileDir);
}

export function inboxTriageProfile(config: InboxConfig, profiles: Record<string, ProfileConfig>): ProfileConfig {
  const profile = profiles[config.triageProfile || config.executorProfile];
  if (!profile || profile.mode === 'team' || !supportsProfileModelService(profile)) {
    throw new Error('请选择独立筛选模型服务，或提供 Responses 配置的旧版个人筛选 profile');
  }
  return profile;
}

export function loadInboxTriageModel(config: InboxConfig, profile: ProfileConfig, profileDir?: string) {
  const separate = config.triageProfile && config.triageProfile !== config.executorProfile;
  return loadProfileModelService(profile, config.triageModel ?? (separate ? INBOX_ANALYSIS_MODEL : config.analysisModel ?? INBOX_ANALYSIS_MODEL), profileDir);
}
