import { isAbsolute } from 'node:path';

/** References only: resolved credentials never belong in the model-service registry. */
export interface ModelSecretRef { source: 'env' | 'file'; id: string }
export interface ModelServiceConfig {
  protocol: 'responses';
  baseUrl: string;
  model: string;
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
  const config = record(input); fields(config, ['protocol', 'baseUrl', 'model', 'apiKey', 'headers']);
  if (config.protocol !== 'responses') throw new Error('目前模型服务支持 responses 协议');
  let url: URL;
  try { url = new URL(typeof config.baseUrl === 'string' ? config.baseUrl : ''); }
  catch { throw new Error('模型服务 baseUrl 必须是 HTTPS API 根地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('模型服务 baseUrl 必须是 HTTPS，且不含凭据、查询参数或片段');
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 200 || /[\x00-\x20\x7f]/.test(config.model.trim())) throw new Error('请设置有效的模型服务默认模型');
  const headers: Record<string, ModelSecretRef> = {};
  if (config.headers !== undefined) for (const [name, ref] of Object.entries(record(config.headers))) {
    if (!/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(name) ||
        ['authorization', 'content-type', 'content-length', 'host', 'connection', 'transfer-encoding', 'constructor', 'prototype', '__proto__'].includes(name.toLowerCase()) ||
        Object.keys(headers).some(existing => existing.toLowerCase() === name.toLowerCase())) throw new Error('模型服务包含无效、重复或保留的请求头');
    headers[name] = secretRef(ref);
  }
  return { protocol: 'responses', baseUrl: url.href.replace(/\/+$/, ''), model: config.model.trim(),
    apiKey: secretRef(config.apiKey), ...(Object.keys(headers).length ? { headers } : {}) };
}

export function normalizeModelServices(input: unknown): Record<string, ModelServiceConfig> {
  if (input === undefined) return {};
  return Object.fromEntries(Object.entries(record(input)).map(([name, config]) => [modelServiceName(name), normalizeModelService(config)]));
}
