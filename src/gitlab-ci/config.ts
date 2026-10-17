import { isAbsolute } from 'node:path';
import { normalizeInbox, validateInbox, type InboxConfig } from '../inbox/config';

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
  model: string;
  outputDir: string;
  repositories: GitLabRepository[];
  notification?: Pick<InboxConfig, 'ownerOpenId' | 'destination' | 'deliveryMode'>;
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
      ? Math.max(30, Math.min(3600, Math.floor(c.pollSeconds))) : 60,
    model: str(c.model) || 'deepseek-flash',
    outputDir: str(c.outputDir),
    repositories: Array.isArray(c.repositories) ? c.repositories.map(r => ({
      project: str(r?.project), sourceDir: str(r?.sourceDir),
      refs: Array.isArray(r?.refs) ? [...new Set(r.refs.map(str).filter(Boolean))] : [],
    })) : [],
    ...(c.notification ? { notification: {
      ownerOpenId: str(c.notification.ownerOpenId),
      destination: normalizeInbox(c.notification).destination,
      deliveryMode: c.notification.deliveryMode === 'new_topic' ? 'new_topic' as const : 'thread' as const,
    } } : {}),
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
  if (c.notification) validateInbox(normalizeInbox({ ...c.notification, enabled: true, executorProfile: c.executorProfile }));
  const seen = new Set<string>();
  for (const r of c.repositories) {
    if (!/^(?:[1-9]\d*|[\w.-]+(?:\/[\w.-]+)+)$/.test(r.project) || seen.has(r.project)) {
      throw new Error('GitLab CI repositories must have unique numeric IDs or namespace/project paths');
    }
    if (r.sourceDir && !isAbsolute(r.sourceDir)) throw new Error('GitLab CI sourceDir must be absolute');
    seen.add(r.project);
  }
}
