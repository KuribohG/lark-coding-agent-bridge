import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { normalizeModelService, modelServiceEndpoint, type ModelProtocol, type ModelSecretRef, type ModelServiceConfig } from './config';

/** Resolved request settings. Keep this object inside the model client boundary. */
export interface ResponsesModelService { url: string; model: string; key: string; headers?: Record<string, string> }

async function credential(ref: ModelSecretRef): Promise<string> {
  let value: string | undefined;
  if (ref.source === 'env') value = process.env[ref.id];
  else {
    const file = await open(ref.id, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => { throw new Error('无法读取模型服务凭据文件'); });
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 64 * 1024) throw new Error('模型服务凭据文件须为不超过 64 KiB 的普通文本文件');
      // Bound the read even if the file grows after stat().
      const buffer = Buffer.alloc(64 * 1024 + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > 64 * 1024) throw new Error('模型服务凭据文件过大');
      value = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  }
  value = value?.trim();
  if (!value || value.length > 64 * 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('模型服务凭据缺失或格式无效，请检查所选环境变量或文件');
  return value;
}

/** Load only the explicitly selected service; never infer agent/profile credentials. */
export async function loadModelService(input: ModelServiceConfig, modelOverride?: string): Promise<ResponsesModelService> {
  const connection = await loadModelConnection(input, 'responses', modelOverride);
  return { url: `${connection.baseUrl}/responses`, model: connection.model, key: connection.key, headers: connection.headers };
}

export interface ModelConnection { baseUrl: string; model: string; key: string; headers?: Record<string, string>; contextWindow?: number }

export async function loadModelConnection(input: ModelServiceConfig, protocol: ModelProtocol, modelOverride?: string): Promise<ModelConnection> {
  const config = normalizeModelService(modelOverride?.trim() ? { ...input, model: modelOverride } : input);
  const endpoint = modelServiceEndpoint(config, protocol);
  if (!endpoint) throw new Error(`模型服务未配置 ${protocol} 协议入口`);
  const model = modelOverride?.trim() || endpoint.model;
  const headers: Record<string, string> = {};
  for (const [name, ref] of Object.entries(config.headers ?? {})) headers[name] = await credential(ref);
  return { baseUrl: endpoint.baseUrl, model, key: await credential(config.apiKey), headers, contextWindow: endpoint.contextWindow };
}
