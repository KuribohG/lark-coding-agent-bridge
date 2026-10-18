import { table, string, boolean, integer, choice, array, fail } from './validation';
import { parseStorageConfig, type StorageMonitorConfig } from '../storage-monitor/config';
import { parse, stringify, TomlError } from 'smol-toml';
import { normalizeInbox, validateInbox, type InboxConfig } from '../inbox/config';
import { normalizeGitLabCi, validateGitLabCi, type GitLabCiConfig } from '../gitlab-ci/config';
import type { RootConfig } from '../config/profile-schema';
import { supportsBackgroundProfile } from '../runtime/agent-capabilities';
import { inboxTriageSource } from '../inbox/model-routing';

export interface MonitorSettings { inbox?: InboxConfig; gitlabCi?: GitLabCiConfig; storageMonitor?: StorageMonitorConfig }
const destination = table({ chatId: string, threadId: string, replyTo: string });
const deliveryMode = choice('thread', 'new_topic');
const lark = table({
  enabled: boolean, executorProfile: string, ownerOpenId: string, destination, deliveryMode,
  intakeScope: choice('private', 'private_mentions', 'all'), watchPrivate: boolean, watchMentions: boolean,
  autoAnalyze: (v, p) => { if (v !== false) fail(p, '旧版 autoAnalyze 仅支持 false'); },
  attentionProfile: string, analysisModel: string, triageService: string, triageProfile: string, triageModel: string,
  dailyTriageLimit: integer(0, 1_000_000), waitMinutes: integer(1, 1440), pollSeconds: integer(1, 3600),
  contextMinutes: integer(5, 1440), maxContextChars: integer(2000, 100_000), dailyAutoLimit: integer(0, 1000),
  h5: table({ publicUrl: string, port: integer(1024, 65535) }), gui: table({ publicUrl: string, apiKeyFile: string }),
});
const gitlab = table({
  enabled: boolean, executorProfile: string, url: string, tokenEnv: string, credentialsFile: string,
  pollSeconds: integer(1, 3600), model: string, outputDir: string,
  repositories: array(table({ project: string, refs: array(string), sourceDir: string })),
  notification: table({ ownerOpenId: string, destination, deliveryMode }),
});

export function parseMonitorConfig(text: string): MonitorSettings {
  let value: Record<string, unknown>;
  try { value = parse(text); }
  catch (error) {
    // Parser code blocks may contain accidentally pasted credentials.
    throw new Error(error instanceof TomlError ? `监控 TOML 语法错误：第 ${error.line} 行，第 ${error.column} 列` : '监控 TOML 语法错误');
  }
  table({ version: integer(1, 1), sources: table({ lark, gitlab_ci: gitlab, storage: v => { parseStorageConfig(v); } }) })(value, 'monitors');
  if (value.version !== 1 || !value.sources) fail('monitors', '需要 version = 1 和 [sources]');
  const sources = value.sources as Record<string, unknown>;
  const settings: MonitorSettings = {
    ...(sources.storage ? { storageMonitor: parseStorageConfig(sources.storage) } : {}),
    ...(sources.lark ? { inbox: normalizeInbox(sources.lark) } : {}),
    ...(sources.gitlab_ci ? { gitlabCi: normalizeGitLabCi(sources.gitlab_ci) } : {}),
  };
  if (settings.inbox) validateInbox(settings.inbox);
  if (settings.gitlabCi) validateGitLabCi(settings.gitlabCi);
  return settings;
}

export function formatMonitorConfig(settings: MonitorSettings): string {
  const sources = { ...(settings.storageMonitor ? { storage: parseStorageConfig(settings.storageMonitor) } : {}), ...(settings.inbox ? { lark: normalizeInbox(settings.inbox) } : {}),
    ...(settings.gitlabCi ? { gitlab_ci: normalizeGitLabCi(settings.gitlabCi) } : {}) };
  return '# Bridge 监控配置：飞书、GitLab CI 与存储/任务监控共用此文件。\n' +
    '# enabled 控制来源开关；executorProfile 选择执行身份；pollSeconds 单位为秒。\n' +
    '# 凭据只填环境变量名或文件路径，密钥保留在现有凭据存储中。\n' +
    '# 工作台保存会规范化格式，原文件（含注释）保存在同路径的 .bak 文件。\n\n' +
    stringify(JSON.parse(JSON.stringify({ version: 1, sources }))) + '\n';
}

/** Checks references without reading credentials or contacting any source. */
export function validateMonitorReferences(settings: MonitorSettings, root: RootConfig): void {
  for (const [name, config] of [['lark', settings.inbox], ['gitlab_ci', settings.gitlabCi], ['storage', settings.storageMonitor]] as const) {
    if (!config?.enabled) continue;
    const profile = root.profiles[config.executorProfile];
    if (!profile || !supportsBackgroundProfile(profile)) fail(`sources.${name}.executorProfile`, '需要支持后台分析的个人 profile');
  }
  if (settings.inbox && (settings.inbox.enabled || settings.inbox.triageService)) inboxTriageSource(settings.inbox, root);
}
