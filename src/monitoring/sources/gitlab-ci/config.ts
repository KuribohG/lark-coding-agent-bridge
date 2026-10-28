import { isAbsolute } from 'node:path';
import { normalizeNotification, validateNotification, notificationSchema, type MonitorNotification } from '../../notification';
import { table, string, boolean, integer, array } from '../../validation';
import { defineMonitorConfig } from '../../module';

export interface GitLabRepository {
  project: string;
  refs: string[];
  sourceDir: string;
}

export interface GitLabCiConfig {
  enabled: boolean;
  executorProfile: string;
  url: string;
  tokenEnv: string;
  credentialsFile: string;
  pollSeconds: number;
  /** Absent preserves the executor's background default; empty follows its profile/CLI. */
  model?: string;
  outputDir: string;
  repositories: GitLabRepository[];
  notification?: MonitorNotification;
}

export function normalizeGitLabCi(input: unknown): GitLabCiConfig {
  const c = (input && typeof input === 'object' ? input : {}) as Partial<GitLabCiConfig>;
  const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  return {
    enabled: c.enabled === true,
    executorProfile: str(c.executorProfile),
    url: str(c.url).replace(/\/+$/, ''),
    tokenEnv: str(c.tokenEnv) || 'GITLAB_TOKEN',
    credentialsFile: str(c.credentialsFile),
    pollSeconds: typeof c.pollSeconds === 'number' && Number.isFinite(c.pollSeconds)
      ? Math.max(1, Math.min(3600, Math.floor(c.pollSeconds))) : 60,
    ...(typeof c.model === 'string' ? { model: str(c.model) } : {}),
    outputDir: str(c.outputDir),
    repositories: Array.isArray(c.repositories) ? c.repositories.map(r => ({
      project: str(r?.project), sourceDir: str(r?.sourceDir),
      refs: Array.isArray(r?.refs) ? [...new Set(r.refs.map(str).filter(Boolean))] : [],
    })) : [],
    ...(c.notification ? { notification: normalizeNotification(c.notification) } : {}),
  };
}

export function validateGitLabCi(c: GitLabCiConfig): void {
  if (!c.enabled) return;
  const url = new URL(c.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('GitLab CI requires an HTTPS URL without credentials or query parameters');
  }
  if (!c.executorProfile || !isAbsolute(c.outputDir)) throw new Error('GitLab CI requires executorProfile and an absolute outputDir');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.tokenEnv) || (c.credentialsFile && !isAbsolute(c.credentialsFile))) {
    throw new Error('GitLab CI requires a token environment variable or an absolute credentialsFile');
  }
  if (!c.repositories.length) throw new Error('GitLab CI requires at least one repository');
  if (c.notification) validateNotification(c.notification, c.executorProfile);
  const seen = new Set<string>();
  for (const r of c.repositories) {
    if (!/^(?:[1-9]\d*|[\w.-]+(?:\/[\w.-]+)+)$/.test(r.project) || seen.has(r.project)) {
      throw new Error('GitLab CI repositories must have unique numeric IDs or namespace/project paths');
    }
    if (r.sourceDir && !isAbsolute(r.sourceDir)) throw new Error('GitLab CI sourceDir must be absolute');
    seen.add(r.project);
  }
}

const schema = table({
  enabled: boolean, executorProfile: string, url: string, tokenEnv: string, credentialsFile: string,
  pollSeconds: integer(1, 3600), model: string, outputDir: string,
  repositories: array(table({ project: string, refs: array(string), sourceDir: string })),
  notification: notificationSchema,
});

export const gitlabMonitorConfig = defineMonitorConfig({
  id: 'gitlab_ci', key: 'gitlabCi',
  normalize: normalizeGitLabCi,
  parse(value) { schema(value, 'monitors.sources.gitlab_ci'); const config = normalizeGitLabCi(value); validateGitLabCi(config); return config; },
  summary: config => ({ repositories: config?.repositories.map(r => r.project) ?? [] }),
});
