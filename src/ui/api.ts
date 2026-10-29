import { readProfileSnapshot } from '../config/service';
import {
  applyPreferencesChange,
  preparePreferencesChange,
  PreferencesApplyError,
  PreferencesValidationError,
} from '../config/preferences';
import { AGENT_OPTIONS } from '../agent/backends';
import { availableEfforts } from '../agent/model-settings';
import { modelEnvironment } from '../runtime/model-settings';
import type { LarkChannel } from '@larksuite/channel';
import { fetchKnownChats } from '../bot/lark-info';
import {
  ADD_BOT_SCOPES,
  addBotToChat,
  completeDeviceLogin,
  getUserAuthStatus,
  hasScope,
  listUserChats,
  searchUserChats,
  startDeviceLogin,
  type AddBotResult,
} from '../lark-cli/user-im';
import { isMeetingNo } from '../meeting/api';
import { checkMeetingPreflight, type MeetingPreflight } from '../meeting/preflight';
import { describeMeetingError, type MeetingManager, type MeetingPushHealth } from '../meeting/manager';
import type { MeetingSessionStatus } from '../meeting/session';
import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig, runtimeProfileConfig } from '../config/profile-store';
import { saveAccessConfig, type MutableProfileState } from '../config/config-ops';
import {
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  type CotMessagesMode,
  type MessageReplyMode,
} from '../config/schema';
import type {
  AgentKind,
  MeetingConfig,
  LarkCliIdentityPreset,
  ProfileAccess,
  ProfileMode,
} from '../config/profile-schema';
import { normalizeModelSelection } from '../agent/models';
import { log } from '../core/logger';
import { HttpError } from './http';
import type { UiRuntime } from './types';

/** HTTP-shaped error the server turns into a JSON error response. */
class ApiError extends HttpError {}

/** The settings payload the SPA reads and writes. */
export interface ConfigView {
  configRevision: string;
  profile: string;
  agentKind: AgentKind;
  agents: { value: AgentKind; label: string }[];
  mode: ProfileMode;
  model: string;
  reasoningEffort: string;
  reasoningEfforts: string[];
  models: { value: string; label: string }[];
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  cotMessages: CotMessagesMode;
  maxConcurrentRuns: number;
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentityPreset;
  meeting: MeetingConfig;
  access: {
    allowedUsers: string[];
    allowedChats: string[];
    admins: string[];
    /** Per-chat @-mention override (chat_id → bool); overrides the global
     * requireMentionInGroup. Absent chats follow the global setting. */
    chatRequireMention: Record<string, boolean>;
  };
  /** True when edits to this profile apply live (its process hosts the UI). */
  live: boolean;
}

export async function buildConfigView(state: MutableProfileState, live = false): Promise<ConfigView> {
  const snapshot = await readProfileSnapshot(state);
  state = snapshot.state;
  const environment = await modelEnvironment(state, state.profileConfig.agentKind, true);
  const agentKind = state.profileConfig.agentKind;
  const ms = getRunIdleTimeoutMs(state.cfg);
  return {
    configRevision: snapshot.revision,
    profile: state.profile,
    agentKind,
    agents: [...AGENT_OPTIONS],
    mode: state.profileConfig.mode,
    model: normalizeModelSelection(agentKind, state.cfg.preferences?.model),
    models: environment.models,
    reasoningEffort: state.cfg.preferences?.reasoningEffort ?? 'default',
    reasoningEfforts: availableEfforts(agentKind),
    messageReply: getMessageReplyMode(state.cfg),
    showToolCalls: getShowToolCalls(state.cfg),
    cotMessages: getCotMessages(state.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(state.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(state.cfg),
    larkCliIdentity: state.profileConfig.larkCli.identityPreset,
    meeting: state.profileConfig.meeting,
    access: {
      allowedUsers: state.profileConfig.access.allowedUsers,
      allowedChats: state.profileConfig.access.allowedChats,
      admins: state.profileConfig.access.admins,
      chatRequireMention: state.profileConfig.access.chatRequireMention ?? {},
    },
    live,
  };
}

/**
 * Build a disk-backed {@link MutableProfileState} for any profile (running or
 * not) from the shared root config. Lets the console read/edit non-hosting
 * profiles — writes land on disk and take effect when that profile next starts.
 */
export async function loadProfileState(
  profile: string,
  rootDir?: string,
): Promise<MutableProfileState> {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const root = await loadRootConfig(appPaths.configFile);
  if (!root?.profiles[profile]) throw new ApiError(404, `profile not found: ${profile}`);
  return {
    configPath: appPaths.configFile,
    profile,
    cfg: runtimeProfileConfig(root, profile),
    profileConfig: root.profiles[profile]!,
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'expected a JSON object body');
  }
  return body as Record<string, unknown>;
}

/**
 * Apply a settings change to the profile whose process hosts the UI — live,
 * in-memory, no restart. Runs the lark-cli identity policy (with rollback) like
 * the chat form. Use {@link applyConfigToDisk} for other profiles.
 */
export async function applyConfig(rt: UiRuntime, body: unknown): Promise<ConfigView> {
  return changeConfig(rt, body, 'live');
}

export async function applyConfigToDisk(state: MutableProfileState, body: unknown): Promise<ConfigView> {
  return changeConfig(state, body, 'disk');
}

async function changeConfig(state: MutableProfileState, body: unknown, mode: 'live' | 'disk'): Promise<ConfigView> {
  try {
    const change = await preparePreferencesChange(state, body);
    await applyPreferencesChange(state, change, mode);
    if (mode === 'live' && change.agentSwitch) {
      if (!('switchAgent' in state) || typeof state.switchAgent !== 'function') {
        throw new ApiError(409, 'agent 类型已保存，但当前运行入口不支持自动切换；请重启此 profile。');
      }
      try {
        await state.switchAgent();
      } catch (err) {
        throw new ApiError(500, `agent 类型已保存，但自动切换失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log.info('ui', 'config-saved', { profile: state.profile, mode: change.mode, live: mode === 'live' });
  } catch (err) {
    if (err instanceof PreferencesValidationError) throw new ApiError(400, err.message);
    if (err instanceof PreferencesApplyError) {
      if (err.rollbackFailed) log.warn('ui', 'identity-rollback-failed', { profile: state.profile });
      throw new ApiError(500, err.step === 'config.lark-cli-policy' ? err.message : `保存失败：${err.message}`);
    }
    throw err;
  }
  return buildConfigView(state, mode === 'live');
}

type AccessKind = 'user' | 'admin' | 'chat';
const ACCESS_LIST: Record<AccessKind, 'allowedUsers' | 'admins' | 'allowedChats'> = {
  user: 'allowedUsers',
  admin: 'admins',
  chat: 'allowedChats',
};

/**
 * Mutate the profile's access. Two operations:
 *  - `add`/`remove` a single id from a list (user/admin/chat) — mirrors
 *    `/invite` `/remove`. Removing a chat also drops its @-mention override.
 *  - `set-mention`: set (or clear) a chat's per-chat @-mention override. Pass
 *    `requireMention: true|false` to override, or `null` to follow the global.
 */
export async function mutateAccess(
  state: MutableProfileState,
  body: unknown,
): Promise<ConfigView['access']> {
  const fv = asRecord(body);
  const action = fv.action;
  const kind = fv.kind;
  const id = typeof fv.id === 'string' ? fv.id.trim() : '';

  if (action === 'set-mention') {
    if (!id) throw new ApiError(400, 'id is required');
    if (
      fv.requireMention !== null &&
      typeof fv.requireMention !== 'boolean' &&
      fv.requireMention !== undefined
    ) {
      throw new ApiError(400, 'requireMention must be boolean or null');
    }
    const requireMention = typeof fv.requireMention === 'boolean' ? fv.requireMention : null;
    const access = await saveAccessConfig(state, (current) => {
      const map = { ...(current.chatRequireMention ?? {}) };
      if (requireMention === null) delete map[id];
      else map[id] = requireMention;
      return { ...current, chatRequireMention: map };
    });
    return accessView(access);
  }

  if (action !== 'add' && action !== 'remove') {
    throw new ApiError(400, 'action must be add|remove|set-mention');
  }
  if (kind !== 'user' && kind !== 'admin' && kind !== 'chat') {
    throw new ApiError(400, 'kind must be user|admin|chat');
  }
  if (!id) throw new ApiError(400, 'id is required');
  const listKey = ACCESS_LIST[kind];

  const access = await saveAccessConfig(state, (current) => {
    const set = new Set(current[listKey]);
    if (action === 'add') set.add(id);
    else set.delete(id);
    const next = { ...current, [listKey]: [...set] };
    // Dropping a chat also drops its @-mention override so it can't linger.
    if (action === 'remove' && kind === 'chat' && next.chatRequireMention?.[id] !== undefined) {
      const map = { ...next.chatRequireMention };
      delete map[id];
      next.chatRequireMention = map;
    }
    return next;
  });
  return accessView(access);
}

function accessView(access: ProfileAccess): ConfigView['access'] {
  return {
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    chatRequireMention: access.chatRequireMention ?? {},
  };
}

/** Known chats for the group picker (best-effort; [] if no live channel). */
export async function listChats(channel: LarkChannel | undefined) {
  if (!channel) return { chats: [] };
  const chats = await fetchKnownChats(channel).catch(() => []);
  return { chats };
}

// ── in-meeting agent ─────────────────────────────────────────────────────────

export interface MeetingsView {
  /** False when the profile is offline or `meeting.enabled` is off. */
  available: boolean;
  reason?: string;
  sessions: MeetingSessionStatus[];
  push: MeetingPushHealth;
}

/**
 * Live meeting state for a profile. Needs the running process's manager, so an
 * offline profile reports `available: false` rather than erroring.
 */
export function meetingsView(manager: MeetingManager | undefined, enabled: boolean): MeetingsView {
  if (!enabled) {
    return {
      available: false,
      reason: '该 profile 未启用会议智能体',
      sessions: [],
      push: { hooked: false, received: 0 },
    };
  }
  if (!manager) {
    return {
      available: false,
      reason: 'profile 未在线（会议能力只在运行中的进程里可用）',
      sessions: [],
      push: { hooked: false, received: 0 },
    };
  }
  return { available: true, sessions: manager.list(), push: manager.pushHealth() };
}

/**
 * Whether the app identity can actually join meetings. Runs a read-only probe;
 * when a scope is missing the result carries Feishu's own scope-apply URL so
 * the console can offer a one-click grant.
 */
export async function meetingPreflight(
  profile: string,
  rootDir: string | undefined,
  probeUserId?: string,
): Promise<MeetingPreflight> {
  return checkMeetingPreflight({
    profile,
    ...(rootDir ? { rootDir } : {}),
    ...(probeUserId ? { probeUserId } : {}),
  });
}

/** Join a meeting by 9-digit number from the console. */
export async function meetingJoin(
  manager: MeetingManager | undefined,
  body: unknown,
): Promise<{ ok: true; session: MeetingSessionStatus }> {
  if (!manager) throw new ApiError(400, '会议能力不可用：profile 未在线或未启用');
  const fv = asRecord(body);
  const meetingNo = typeof fv.meetingNo === 'string' ? fv.meetingNo.replace(/\s/g, '') : '';
  if (!isMeetingNo(meetingNo)) throw new ApiError(400, '会议号必须是 9 位数字');
  try {
    const session = await manager.join(meetingNo);
    return { ok: true, session: session.status() };
  } catch (err) {
    throw new ApiError(400, describeMeetingError(err));
  }
}

/** Leave a meeting from the console. */
export async function meetingLeave(
  manager: MeetingManager | undefined,
  body: unknown,
): Promise<{ ok: boolean }> {
  if (!manager) throw new ApiError(400, '会议能力不可用：profile 未在线或未启用');
  const fv = asRecord(body);
  const meetingId = typeof fv.meetingId === 'string' ? fv.meetingId : '';
  if (!meetingId) throw new ApiError(400, 'meetingId is required');
  return { ok: await manager.leave(meetingId) };
}

// ── user-identity group picker (lark-cli, owner's authorization) ─────────────

/** Auth status for the owner's user identity (for the "我的群" flow). */
export async function userAuthStatus(profile: string, rootDir?: string) {
  return getUserAuthStatus({ profile, rootDir });
}

/**
 * Kick off the OAuth device flow; returns a URL the user opens to authorize.
 * `scopes` defaults (in user-im) to just the view-groups scope — the caller
 * passes the add-member scope only when the user actually needs it.
 */
export async function userLoginStart(profile: string, rootDir: string | undefined, scopes?: string[]) {
  try {
    return await startDeviceLogin({ profile, rootDir }, scopes);
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err));
  }
}

/** Finish the device flow after the user authorized in the browser. */
export async function userLoginComplete(profile: string, rootDir: string | undefined, body: unknown) {
  const fv = asRecord(body);
  const deviceCode = typeof fv.deviceCode === 'string' ? fv.deviceCode : '';
  if (!deviceCode) throw new ApiError(400, 'deviceCode is required');
  const r = await completeDeviceLogin({ profile, rootDir }, deviceCode);
  if (!r.ok) throw new ApiError(400, r.message ?? '授权尚未完成');
  return { ok: true };
}

export interface UserChatView {
  id: string;
  name: string;
  /** True when the bot is already a member (allowlisting it takes effect). */
  botInIt: boolean;
}

/**
 * List the owner's groups (as the user) and mark which ones the bot is already
 * in (by cross-referencing the bot's own chat list from the live channel).
 */
export async function userChatsView(
  profile: string,
  rootDir: string | undefined,
  channel: LarkChannel | undefined,
  opts: { query?: string; pageToken?: string } = {},
): Promise<{ chats: UserChatView[]; nextPageToken?: string; botKnown: boolean }> {
  const query = (opts.query ?? '').trim();
  let page;
  try {
    page = query
      ? await searchUserChats({ profile, rootDir }, { query, pageToken: opts.pageToken })
      : await listUserChats({ profile, rootDir }, { pageToken: opts.pageToken });
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err));
  }
  const botChats = channel ? await fetchKnownChats(channel).catch(() => []) : [];
  const botIds = new Set(botChats.map((c) => c.id));
  return {
    // botKnown=false (offline) → we can't tell membership, so don't claim "in".
    botKnown: Boolean(channel),
    chats: page.chats.map((c) => ({ ...c, botInIt: botIds.has(c.id) })),
    ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
  };
}

/** Add the bot to a group the owner is in (as the user). */
export async function addBotToChatView(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<AddBotResult> {
  const fv = asRecord(body);
  const chatId = typeof fv.chatId === 'string' ? fv.chatId.trim() : '';
  if (!chatId) throw new ApiError(400, 'chatId is required');
  // The listing flow only asks for the view scope; adding a member needs the
  // write scope. If it's missing, ask the UI to run a targeted re-auth rather
  // than surfacing a confusing permission error from the API.
  const status = await getUserAuthStatus({ profile, rootDir });
  if (!status.loggedIn || !hasScope(status, ADD_BOT_SCOPES)) {
    return { ok: false, pending: false, needAuth: true, message: '拉bot进群需要额外授权（添加群成员）' };
  }
  const state = await loadProfileState(profile, rootDir);
  const botAppId = state.cfg.accounts?.app?.id;
  if (!botAppId) throw new ApiError(400, 'profile 未配置 app');
  return addBotToChat({ profile, rootDir }, chatId, botAppId);
}
