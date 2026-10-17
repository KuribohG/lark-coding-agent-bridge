import { open, readFile } from 'node:fs/promises';
import type { GitLabCiConfig } from './config';

export interface Pipeline {
  id: number; status: string; ref: string; sha: string; web_url: string; updated_at: string;
}
export interface FailedJob {
  id: number; name: string; stage: string; status: string; allow_failure: boolean;
  web_url: string; failure_reason?: string;
  kind: 'job' | 'bridge';
  downstream_pipeline?: { id: number; project_id: number; status: string; web_url: string };
}

export class GitLabError extends Error {}

// Deliberately parse assignments, never execute a shell credentials file.
export function parseCredentials(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(GITLAB_URL|GITLAB_TOKEN)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (/[`$\r\n]/.test(value)) throw new GitLabError('GitLab credentials must be literal assignments');
    values[match[1]!] = value;
  }
  return values;
}

export async function loadGitLabToken(c: GitLabCiConfig, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let token = env[c.tokenEnv];
  let credentialUrl = env.GITLAB_URL;
  if (!token && c.credentialsFile) {
    let values: Record<string, string>;
    try { values = parseCredentials(await readFile(c.credentialsFile, 'utf8')); }
    catch { throw new GitLabError('Cannot read literal GitLab credentials from the configured file'); }
    token = values.GITLAB_TOKEN;
    credentialUrl = values.GITLAB_URL;
  }
  if (!token) throw new GitLabError('GitLab token is missing');
  if (credentialUrl && credentialUrl.replace(/\/+$/, '') !== c.url) throw new GitLabError('GitLab credential URL does not match the configured URL');
  return token;
}

export class GitLabClient {
  constructor(private url: string, private token: string, private request: typeof fetch = fetch) {}
  private async get(path: string, signal: AbortSignal): Promise<Response> {
    try {
      const response = await this.request(`${this.url}/api/v4${path}`, {
        headers: { 'PRIVATE-TOKEN': this.token }, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) { await response.body?.cancel(); throw new GitLabError(`GitLab API HTTP ${response.status}`); }
      return response;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof GitLabError) throw error;
      throw new GitLabError('GitLab API request failed or timed out');
    }
  }
  private async pages<T>(path: string, signal: AbortSignal): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const response = await this.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, signal);
      const items: unknown = await response.json();
      if (!Array.isArray(items)) throw new GitLabError('Invalid GitLab list response');
      result.push(...items as T[]);
      const next = response.headers.get('x-next-page');
      if (next === '' || (next === null && items.length < 100)) return result;
    }
    throw new GitLabError('GitLab pagination limit reached; cursor was not advanced');
  }
  async pipelines(project: string, since: number, until: number, signal: AbortSignal): Promise<Pipeline[]> {
    const query = new URLSearchParams({ status: 'failed', order_by: 'updated_at', sort: 'asc',
      updated_after: new Date(since).toISOString(), updated_before: new Date(until).toISOString() });
    return this.pages(`/projects/${encodeURIComponent(project)}/pipelines?${query}`, signal);
  }
  async pipeline(project: string, id: number, signal: AbortSignal): Promise<Pipeline> {
    return (await this.get(`/projects/${encodeURIComponent(project)}/pipelines/${id}`, signal)).json() as Promise<Pipeline>;
  }
  async failures(project: string, id: number, signal: AbortSignal): Promise<FailedJob[]> {
    const base = `/projects/${encodeURIComponent(project)}/pipelines/${id}`;
    const jobs = await this.pages<Omit<FailedJob, 'kind'>>(`${base}/jobs?scope[]=failed&include_retried=false`, signal);
    const bridges = await this.pages<Omit<FailedJob, 'kind'>>(`${base}/bridges`, signal);
    return [...jobs.map(j => ({ ...j, kind: 'job' as const })), ...bridges.map(j => ({ ...j, kind: 'bridge' as const }))]
      .filter(j => j.status === 'failed' && !j.allow_failure);
  }
  async trace(project: string, id: number, path: string, signal: AbortSignal, limit = 32 * 1024 * 1024) {
    const response = await this.get(`/projects/${encodeURIComponent(project)}/jobs/${id}/trace`, signal);
    const reader = response.body?.getReader();
    if (!reader) throw new GitLabError('GitLab trace has no body');
    const file = await open(path, 'w', 0o600);
    let bytes = 0, tail = Buffer.alloc(0), truncated = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value).subarray(0, Math.max(0, limit - bytes));
        await file.writeFile(chunk); bytes += chunk.length;
        tail = Buffer.concat([tail, chunk]).subarray(-16_000);
        if (bytes >= limit) { truncated = true; break; }
      }
    } finally { await reader.cancel().catch(() => {}); await file.close(); }
    return { path, bytes, truncated, tail: tail.toString('utf8') };
  }
}
