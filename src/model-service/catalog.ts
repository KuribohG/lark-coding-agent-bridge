import { createHash } from 'node:crypto';
import type { ModelServiceConfig } from './config';
import { loadModelConnection } from './service';

export interface ServiceModel { id: string; label: string }
const cache = new Map<string, { expiresAt: number; result: Promise<ServiceModel[]> }>();

/** Refresh only for explicit picker requests; running tasks use the cached catalog. */
export async function modelServiceCatalog(config: ModelServiceConfig, refresh = false): Promise<ServiceModel[]> {
  const key = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const known = cache.get(key);
  if (known && (!refresh || known.expiresAt > Date.now())) return known.result;
  if (!refresh) return [];
  const result = fetchModels(config).catch(() => []);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, { expiresAt: Date.now() + 60_000, result });
  return result;
}

async function fetchModels(config: ModelServiceConfig): Promise<ServiceModel[]> {
  const connection = await loadModelConnection(config, config.protocol);
  const auth: Record<string, string> = config.protocol === 'gemini'
    ? { 'x-goog-api-key': connection.key } : { Authorization: `Bearer ${connection.key}` };
  const response = await fetch(`${connection.baseUrl}${config.protocol === 'gemini' ? '/v1beta' : ''}/models`, {
    headers: { ...connection.headers, ...auth }, signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) return [];
  const data = await response.json() as { data?: unknown[]; models?: unknown[] };
  return (data.data ?? data.models ?? []).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name.replace(/^models\//, '') : '';
    if (!id || id.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]*$/.test(id)) return [];
    return [{ id, label: typeof row.displayName === 'string' ? row.displayName : id }];
  });
}
