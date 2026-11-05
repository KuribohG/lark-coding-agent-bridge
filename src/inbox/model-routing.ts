import type { RootConfig } from '../config/profile-schema';
import { modelServiceName, normalizeModelService, modelServiceEndpoint, type ModelServiceConfig } from '../model-service/config';
import { loadModelService } from '../model-service/service';
import type { InboxConfig } from './config';

export function inboxTriageService(config: InboxConfig, root: Pick<RootConfig, 'modelServices'>): ModelServiceConfig {
  if (!config.triageService) throw new Error('请选择独立筛选模型服务');
  const service = root.modelServices?.[modelServiceName(config.triageService)];
  if (!service) throw new Error('找不到所选筛选模型服务，请在模型 API 服务中配置');
  if (!modelServiceEndpoint(service, 'responses')) throw new Error('筛选模型服务需要 Responses 协议入口');
  return normalizeModelService(service);
}

export function loadInboxTriageService(config: InboxConfig, service: ModelServiceConfig) {
  return loadModelService(service, config.triageModel);
}
