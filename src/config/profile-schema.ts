import type { AgentLaunchConfig } from '../agent/launch-options';
import type { AgentStateSettings } from '../agent/state-layout';
import { normalizeFileLinks } from './file-links';
import type {
  AppCredentials,
  AppPreferences,
  MessageReplyMode,
  SecretsConfig,
} from './schema';
import {
  normalizePermissions,
  type AccessMode,
  type CodexSandboxMode,
  type PermissionConfig,
} from './permissions';
import {
  AGENT_KINDS,
  agentBackendSpec,
  isAgentKind,
  type AgentKind,
} from '../agent/backend-spec';

export type { AgentKind };
export type SandboxMode = CodexSandboxMode;
export type { AccessMode, PermissionConfig };
export type { AgentLaunchEnvironment, AgentLaunchConfig } from '../agent/launch-options';
export type { CodexConfig, CodexAppServerMode } from '../agent/codex/config';
export type { ClaudeConfig } from '../agent/claude/config';
export type { PiConfig } from '../agent/pi/config';
export type { AgyConfig } from '../agent/agy/config';
import { normalizeAgentLaunches, type AgentLaunchProfiles } from '../agent/launch-config';

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
  /**
   * Per-chat override of {@link requireMentionInGroup}, keyed by chat_id.
   * `true` = require an @-mention in that chat, `false` = respond to every
   * message. A chat absent from the map follows the global setting. Takes
   * priority over `requireMentionInGroup` for the chats it lists.
   */
  chatRequireMention?: Record<string, boolean>;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

export type CommentConfig = Record<string, never>;

export type LarkCliIdentityPreset = 'bot-only' | 'user-default';

/**
 * Deployment mode — a single switch that binds two behaviors together
 * (see the "团队版 Bot 权限调整" spec):
 *   - `personal` (default, the status quo): only owner + allowlisted
 *     users/chats can use the bot; the CLI may carry owner's personal (user)
 *     authorization per {@link LarkCliConfig.identityPreset}.
 *   - `team`: anyone can @-use the bot (no allowlist gating), and the CLI is
 *     forced to `bot-only` so it never carries owner's personal authorization.
 *
 * The two behaviors are intentionally bound to one switch, not two configs.
 * Admin/sensitive commands stay owner/admin-gated in both modes.
 */
export type ProfileMode = 'personal' | 'team';

export type LarkCliUserImportStatus =
  | 'not-needed'
  | 'imported'
  | 'skipped-existing-private-user'
  | 'skipped-no-local-user'
  | 'failed';

export interface LarkCliConfig {
  identityPreset: LarkCliIdentityPreset;
  localUserImport?: {
    status: LarkCliUserImportStatus;
    attemptedAt?: string;
    importedAt?: string;
    reason?: string;
  };
}

/** The subset needed to select and launch an agent, independent of IM account state. */
export interface AgentExecutionProfile extends AgentLaunchProfiles {
  /** Default engine for new/unconfigured scopes and background work. */
  agentKind: AgentKind;
  /** Bridge-wide `[state]` settings, shared by every profile and engine. */
  state?: AgentStateSettings;
  permissions: PermissionConfig;
}

export interface ProfileConfig extends AgentExecutionProfile {
  schemaVersion: 2;
  /** Deployment mode switch. Default 'personal'. See {@link ProfileMode}. */
  mode: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  channels?: import('./schema').ChannelDisplayConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  access: ProfileAccess;
  workspaces: {
    default?: string;
  };
  attachments: AttachmentConfig;
  comments: CommentConfig;
  larkCli: LarkCliConfig;
}

/** Configuration needed to execute a conversation; no messaging credentials. */
export type RunProfileConfig = AgentExecutionProfile & Pick<ProfileConfig,
  'access' | 'workspaces' | 'attachments'> & { preferences: import('./schema').RunPreferences };

/**
 * The lark-cli identity preset that actually takes effect, after applying the
 * deployment-mode override. Team mode forces `bot-only` regardless of the
 * user's stored {@link LarkCliConfig.identityPreset} (which is preserved so it
 * comes back into effect when switching back to personal mode). This is the
 * single source of truth for "team mode forces bot-only" — every place that
 * applies the lark-cli identity policy should read through here.
 */
export function effectiveLarkCliIdentity(
  profile: Pick<ProfileConfig, 'mode' | 'larkCli'>,
): LarkCliIdentityPreset {
  return profile.mode === 'team' ? 'bot-only' : profile.larkCli.identityPreset;
}

/** Resolved runtime DTO. The disk document has its own version and sparse layers. */
export interface RootConfig {
  schemaVersion: 2;
  activeProfile: string;
  /** Profiles the machine-wide supervisor starts automatically. When omitted, only activeProfile starts. */
  autostartProfiles?: string[];
  preferences: Record<string, never>;
  /** Relative to the root config directory; monitoring settings then live only in this TOML file. */
  monitorConfigFile?: string;
  workItemConcurrency?: import('../work-items/concurrency').WorkItemConcurrency;
  inbox?: import('../inbox/config').InboxConfig;
  gitlabCi?: import('../monitoring/sources/gitlab-ci/config').GitLabCiConfig;
  storageMonitor?: import('../monitoring/sources/storage/config').StorageMonitorConfig;
  /** Bridge-wide `[state]` table; also copied into every profile as `state`. */
  agentState?: AgentStateSettings;
  /** Raw global launch layers retained so TOML round trips do not collapse them into profiles. */
  agentLaunches?: Partial<Record<AgentKind, { launch?: AgentLaunchConfig }>>;
  modelServices?: Record<string, import('../model-service/config').ModelServiceConfig>;
  secrets?: SecretsConfig;
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput extends AgentLaunchProfiles {
  agentKind: AgentKind;
  /** Deployment mode. Default 'personal'. */
  mode?: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  permissions?: Partial<PermissionConfig>;
  secrets?: SecretsConfig;
}

export function createDefaultProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input,
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as AgentLaunchProfiles & {
    schemaVersion?: unknown;
    agentKind?: unknown;
    mode?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    channels?: import('./schema').ChannelDisplayConfig;
    preferences?: AppPreferences;
    access?: Partial<ProfileAccess>;
    workspaces?: { default?: unknown };
    permissions?: Partial<PermissionConfig>;
    attachments?: Partial<AttachmentConfig>;
    comments?: unknown;
    larkCli?: unknown;
    state?: AgentStateSettings;
  };

  if (raw.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2');
  }
  if (!isAgentKind(raw.agentKind)) {
    throw new Error(`agentKind must be one of: ${AGENT_KINDS.join(', ')}`);
  }
  const accounts = normalizeAccounts(raw.accounts);
  const backend = agentBackendSpec(raw.agentKind);
  if (backend.launchRequired && !raw[raw.agentKind]) {
    throw new Error(
      `${raw.agentKind} profile requires ${raw.agentKind} configuration`,
    );
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(raw.access);
  const permissions = normalizePermissions(raw.permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const larkCli = normalizeLarkCli(raw.larkCli);

  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    mode: raw.mode === 'team' ? 'team' : 'personal',
    accounts,
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    preferences,
    ...(raw.channels ? { channels: raw.channels } : {}),
    ...normalizeAgentLaunches(raw),
    ...(raw.state ? { state: raw.state } : {}),
    access,
    workspaces,
    permissions,
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    comments,
    larkCli,
  };
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials> };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
  };
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    fileLinks,
    ...rest
  } = preferences ?? {};
  const normalized = normalizeFileLinks(fileLinks);
  const result = { ...rest, ...(normalized !== undefined ? { fileLinks: normalized } : {}) };
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...result,
      messageReply,
    };
  }
  return result;
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function normalizeAccess(access: Partial<ProfileAccess> | undefined): ProfileAccess {
  const chatRequireMention = normalizeChatMentionMap(access?.chatRequireMention);
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? true,
    // Omit when empty so configs without per-chat overrides stay clean.
    ...(Object.keys(chatRequireMention).length > 0 ? { chatRequireMention } : {}),
  };
}

/** Keep only string→boolean entries; drop anything malformed. */
function normalizeChatMentionMap(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, boolean> = {};
  for (const [chatId, value] of Object.entries(input as Record<string, unknown>)) {
    if (chatId && typeof value === 'boolean') out[chatId] = value;
  }
  return out;
}

function normalizeWorkspaces(input: { default?: unknown } | undefined): ProfileConfig['workspaces'] {
  const defaultWorkspace = typeof input?.default === 'string' && input.default.trim()
    ? input.default.trim()
    : undefined;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}

function normalizeComments(_input: unknown): CommentConfig {
  return {};
}

function normalizeLarkCli(input: unknown): LarkCliConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { identityPreset: 'bot-only' };
  }
  const raw = input as {
    identityPreset?: unknown;
    localUserImport?: unknown;
  };
  const identityPreset: LarkCliIdentityPreset =
    raw.identityPreset === 'user-default' ? 'user-default' : 'bot-only';
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...(localUserImport ? { localUserImport } : {}),
  };
}

function normalizeLarkCliUserImport(input: unknown): LarkCliConfig['localUserImport'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as {
    status?: unknown;
    attemptedAt?: unknown;
    importedAt?: unknown;
    reason?: unknown;
  };
  if (!isLarkCliUserImportStatus(raw.status)) return undefined;
  return {
    status: raw.status,
    ...(typeof raw.attemptedAt === 'string' ? { attemptedAt: raw.attemptedAt } : {}),
    ...(typeof raw.importedAt === 'string' ? { importedAt: raw.importedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isLarkCliUserImportStatus(value: unknown): value is LarkCliUserImportStatus {
  return (
    value === 'not-needed' ||
    value === 'imported' ||
    value === 'skipped-existing-private-user' ||
    value === 'skipped-no-local-user' ||
    value === 'failed'
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
