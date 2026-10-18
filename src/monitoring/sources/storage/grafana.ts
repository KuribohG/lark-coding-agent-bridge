import { readFile } from 'node:fs/promises';
import type { StorageMonitorConfig } from './config';

export type Row = Record<string, unknown>;
export interface QueryClient { query(datasource: string, type: 'postgres' | 'clickhouse', sql: string, signal: AbortSignal): Promise<Row[]> }

/** Only the documented Grafana variables are read; the file is never evaluated as shell. */
export async function grafanaCredentials(config: StorageMonitorConfig['grafana']): Promise<{ url: string; headers: Record<string, string> }> {
  const values: Record<string, string> = {};
  if (config.credentialsFile) {
    try {
      for (const line of (await readFile(config.credentialsFile, 'utf8')).split('\n')) {
        const match = line.match(/^\s*(?:export\s+)?(GRAFANA_(?:URL|TOKEN|USER|PASSWORD|COOKIE))\s*=\s*(.*?)\s*$/);
        if (match) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 Grafana 凭据文件'); }
  }
  for (const key of ['URL', 'TOKEN', 'USER', 'PASSWORD', 'COOKIE']) {
    const name = `GRAFANA_${key}`;
    if (process.env[name]) values[name] = process.env[name]!;
  }
  let url: URL;
  try { url = new URL(config.url || values.GRAFANA_URL || ''); }
  catch { throw new Error('未配置 Grafana URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Grafana URL 无效');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (values.GRAFANA_TOKEN) headers.Authorization = `Bearer ${values.GRAFANA_TOKEN}`;
  else if (values.GRAFANA_USER && values.GRAFANA_PASSWORD) headers.Authorization = `Basic ${Buffer.from(`${values.GRAFANA_USER}:${values.GRAFANA_PASSWORD}`).toString('base64')}`;
  else if (values.GRAFANA_COOKIE) headers.Cookie = values.GRAFANA_COOKIE.includes('=') ? values.GRAFANA_COOKIE : `grafana_session=${values.GRAFANA_COOKIE}`;
  else throw new Error('Grafana 凭据不可用');
  return { url: url.href.replace(/\/$/, ''), headers };
}

export class GrafanaQueryClient implements QueryClient {
  constructor(private auth: { url: string; headers: Record<string, string> }, private request = fetch) {}
  async query(datasource: string, type: 'postgres' | 'clickhouse', sql: string, signal: AbortSignal): Promise<Row[]> {
    let response: Response;
    try {
      response = await this.request(`${this.auth.url}/api/ds/query`, {
        method: 'POST', redirect: 'error', headers: this.auth.headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        body: JSON.stringify({ from: 'now-1h', to: 'now', queries: [{ refId: 'A',
          datasource: { uid: datasource, type: type === 'postgres' ? 'grafana-postgresql-datasource' : 'grafana-clickhouse-datasource' },
          rawSql: sql, ...(type === 'postgres' ? { format: 'table' } : { format: 1, editorType: 'sql', queryType: 'table' }),
        }] }),
      });
    } catch { signal.throwIfAborted(); throw new Error('Grafana 请求失败或超时'); }
    if (!response.ok) throw new Error(`Grafana HTTP ${response.status}`);
    // Never propagate an upstream error body: it can contain SQL or credentials.
    let body: unknown;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 20_000_000) { await reader.cancel(); throw new Error(); } chunks.push(part.value); }
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { throw new Error('Grafana 响应无效或超过大小限制'); }
    return frameRows(body);
  }
}

export function frameRows(body: unknown): Row[] {
  const result = (body as { results?: { A?: { error?: unknown; status?: number; frames?: unknown[] } } })?.results?.A;
  if (!result || result.error || (result.status && result.status >= 400) || !Array.isArray(result.frames)) throw new Error('Grafana 查询未成功');
  const rows: Row[] = [];
  for (const raw of result.frames) {
    const frame = raw as { schema?: { fields?: { name: string }[] }; data?: { values?: unknown[][] } };
    const fields = frame.schema?.fields; const values = frame.data?.values;
    if (!fields || !values || fields.length !== values.length || values.some(v => !Array.isArray(v) || v.length !== values[0]?.length)) throw new Error('Grafana 数据列不完整');
    for (let i = 0; i < (values[0]?.length ?? 0); i++) rows.push(Object.fromEntries(fields.map((f, j) => [f.name, values[j]![i]])));
  }
  return rows;
}

export const sqlString = (value: string) => `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
export function numberField(row: Row, name: string): number {
  const value = row[name]; const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error(`指标字段缺失或无效：${name}`);
  return n;
}
