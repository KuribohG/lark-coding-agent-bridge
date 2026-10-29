import { isAbsolute } from 'node:path';

export type ModelProtocol = 'responses' | 'gemini';
export interface ModelEndpoint { baseUrl: string; model?: string; contextWindow?: number }

/** References only: resolved credentials never belong in the model-service registry. */
export interface ModelSecretRef { source: 'env' | 'file'; id: string }
export interface ModelServiceConfig {
  protocol: ModelProtocol;
  /** Additional native wire endpoints sharing these credentials. */
  endpoints?: Partial<Record<ModelProtocol, ModelEndpoint>>;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  apiKey: ModelSecretRef;
  /** Extra request headers, with values resolved from the same reference format. */
  headers?: Record<string, ModelSecretRef>;
}

export function modelServiceName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) ||
      ['constructor', 'prototype', '__proto__'].includes(value)) throw new Error('模型服务名称须为 1–64 位字母、数字、下划线或横线，且以字母或数字开头');
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型服务配置须为对象');
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('模型服务配置含不支持的字段；密钥和请求头须使用环境变量或文件引用');
}

function secretRef(value: unknown): ModelSecretRef {
  const ref = record(value); fields(ref, ['source', 'id']);
  if (typeof ref.id !== 'string' || !ref.id || ref.id.length > 4096 || /[\0\r\n]/.test(ref.id)) throw new Error('模型服务凭据引用无效');
  if (ref.source === 'env' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ref.id)) return { source: ref.source, id: ref.id };
  if (ref.source === 'file' && isAbsolute(ref.id)) return { source: ref.source, id: ref.id };
  throw new Error('模型服务凭据须引用环境变量名或文件绝对路径');
}

export function normalizeModelService(input: unknown): ModelServiceConfig {
  const config = record(input); fields(config, ['protocol', 'baseUrl', 'model', 'apiKey', 'headers', 'endpoints', 'contextWindow']);
  if (config.protocol !== 'responses' && config.protocol !== 'gemini') throw new Error('模型服务支持 responses 或 gemini 协议');
  const baseUrl = endpointUrl(config.baseUrl);
  const model = endpointModel(config.model);
  const contextWindow = tokenWindow(config.contextWindow);
  const endpoints: Partial<Record<ModelProtocol, ModelEndpoint>> = {};
  if (config.endpoints !== undefined) {
    const inputEndpoints = record(config.endpoints); fields(inputEndpoints, ['responses', 'gemini']);
    for (const [protocol, value] of Object.entries(inputEndpoints)) {
      const endpoint = record(value); fields(endpoint, ['baseUrl', 'model', 'contextWindow']);
      endpoints[protocol as ModelProtocol] = { baseUrl: endpointUrl(endpoint.baseUrl),
        ...(endpoint.contextWindow !== undefined ? { contextWindow: tokenWindow(endpoint.contextWindow) } : {}),
        ...(endpoint.model !== undefined ? { model: endpointModel(endpoint.model) } : {}) };
    }
  }
  const headers: Record<string, ModelSecretRef> = {};
  if (config.headers !== undefined) for (const [name, ref] of Object.entries(record(config.headers))) {
    if (!/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(name) ||
        ['authorization', 'x-goog-api-key', 'content-type', 'content-length', 'host', 'connection', 'transfer-encoding', 'constructor', 'prototype', '__proto__'].includes(name.toLowerCase()) ||
        Object.keys(headers).some(existing => existing.toLowerCase() === name.toLowerCase())) throw new Error('模型服务包含无效、重复或保留的请求头');
    headers[name] = secretRef(ref);
  }
  return { protocol: config.protocol, baseUrl, model,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(Object.keys(endpoints).length ? { endpoints } : {}),
    apiKey: secretRef(config.apiKey), ...(Object.keys(headers).length ? { headers } : {}) };
}

export function normalizeModelServices(input: unknown): Record<string, ModelServiceConfig> {
  if (input === undefined) return {};
  return Object.fromEntries(Object.entries(record(input)).map(([name, config]) => [modelServiceName(name), normalizeModelService(config)]));
}

export function modelServiceEndpoint(config: ModelServiceConfig, protocol: ModelProtocol): (ModelEndpoint & { model: string }) | undefined {
  const endpoint = config.endpoints?.[protocol];
  if (endpoint) return { ...endpoint, model: endpoint.model ?? config.model };
  return config.protocol === protocol ? { baseUrl: config.baseUrl, model: config.model,
    ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}) } : undefined;
}

function tokenWindow(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1024 || value > 100_000_000) throw new Error('模型 contextWindow 必须是至少 1024 的 token 数');
  return value;
}

function endpointUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value : ''); }
  catch { throw new Error('模型服务 baseUrl 必须是 HTTPS API 根地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('模型服务 baseUrl 必须是 HTTPS，且不含凭据、查询参数或片段');
  return url.href.replace(/\/+$/, '');
}

function endpointModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x20\x7f]/.test(value.trim())) throw new Error('请设置有效的模型服务默认模型');
  return value.trim();
}
