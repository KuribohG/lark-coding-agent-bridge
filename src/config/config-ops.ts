import { readFile } from 'node:fs/promises';
import { configRevision } from './profile-store';
import { larkDisplay } from '../channels/lark/config';
import { dirname } from 'node:path';
import { resolveAppPaths } from './app-paths';
import { setSecret } from './keystore';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from './profile-store';
import { secretKeyForApp, type AppConfig, type AppPreferences } from './schema';
import type { ProfileAccess, ProfileConfig, ProfileMode } from './profile-schema';
import { applyLarkCliIdentityPolicy } from '../lark-cli/identity-policy';
import { log, reportMetric } from '../core/logger';

/**
 * The mutable per-profile runtime state these ops read and keep in sync. The
 * running bridge's `Controls` object structurally satisfies this, so both the
 * chat `/config` handlers and the local web UI's REST layer drive config
 * changes through the exact same disk-write + in-memory-refresh logic (no
 * divergent second implementation). `cfg` / `profileConfig` are reassigned in
 * place after a successful save so the live process picks up changes without a
 * restart — mirroring how the chat form already applies preferences/access.
 */
export interface MutableProfileState {
  configPath: string;
  profile: string;
  cfg: AppConfig;
  profileConfig: ProfileConfig;
}

/** Patch model defaults without changing identity/access or losing concurrent fields. */
export async function saveModelPreferences(
  state: MutableProfileState,
  patch: import('../agent/model-settings').ModelSettings,
): Promise<void> {
  await withConfigFileLock(state.configPath, async () => {
    const root = await loadRootConfig(state.configPath);
    if (!root) throw new Error('root config not found');
    const profile = root.profiles[state.profile];
    if (!profile) throw new Error(`profile not found: ${state.profile}`);
    root.profiles[state.profile] = { ...profile, preferences: { ...profile.preferences, ...patch } };
    await saveRootConfig(root, state.configPath);
    state.profileConfig = { ...state.profileConfig, preferences: root.profiles[state.profile]!.preferences };
    state.cfg = { ...state.cfg, preferences: state.profileConfig.preferences };
  });
}

/** App paths for a profile, derived from its config path. */
export function profileAppPaths(state: Pick<MutableProfileState, 'configPath' | 'profile'>) {
  return resolveAppPaths({
    rootDir: dirname(state.configPath),
    profile: state.profile,
  });
}

/**
 * Apply the lark-cli identity policy (`strict-mode` + `default-as`) for a
 * profile. Pass the *effective* preset (team mode forces `bot-only` — see
 * {@link effectiveLarkCliIdentity}). Returns false on failure (logged).
 */
export async function applyProfileLarkCliIdentity(
  state: Pick<MutableProfileState, 'configPath' | 'profile'>,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  const appPaths = profileAppPaths(state);
  const ok = await applyLarkCliIdentityPolicy({
    profile: appPaths.profile,
    rootDir: appPaths.rootDir,
    configPath: state.configPath,
    larkCliConfigDir: appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
  }, larkCliIdentity).catch(() => false);
  if (!ok) {
    log.warn('config-ops', 'lark-cli-identity-policy-apply-failed', {
      profile: appPaths.profile,
      identity: larkCliIdentity,
    });
  }
  return ok;
}

/**
 * Mutate the profile's access lists (allowlists + admins) under the config
 * file lock, persist, and refresh the in-memory state. `mutate` receives the
 * current {@link ProfileAccess} and returns the next one.
 */
export async function saveAccessConfig(
  state: MutableProfileState,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  try {
    return await withConfigFileLock(state.configPath, async () => {
      const root = await loadRootConfig(state.configPath);
      if (!root) throw new Error('root config not found');

      const profile = root.profiles[state.profile];
      if (!profile) throw new Error(`profile not found: ${state.profile}`);
      const access = mutate(profile.access);
      root.profiles[state.profile] = {
        ...profile,
        access,
      };
      await saveRootConfig(root, state.configPath);
      state.profileConfig = { ...state.profileConfig, access: root.profiles[state.profile]!.access };
      state.cfg = { ...state.cfg, ...state.profileConfig };
      log.info('config-ops', 'access-mutated', {
        allowedUsers: access.allowedUsers.length,
        allowedChats: access.allowedChats.length,
        admins: access.admins.length,
      });
      return access;
    });
  } catch (err) {
    reportMetric('command_fail', 1, { step: 'access.save' });
    throw err;
  }
}

/**
 * Store a new App Secret in the keystore and persist the account config
 * (SecretRef in config.toml, plaintext only in the keystore), refreshing
 * in-memory state. Callers restart the bridge afterwards to reconnect with
 * the new credentials.
 */
export async function saveAccountConfig(
  state: MutableProfileState,
  newCfg: AppConfig,
  plaintextSecret: string,
): Promise<void> {
  const appPaths = profileAppPaths(state);
  await setSecret(secretKeyForApp(newCfg.accounts.app.id), plaintextSecret, appPaths);

  await withConfigFileLock(state.configPath, async () => {
    const root = await loadRootConfig(state.configPath);
    if (!root) throw new Error('root config not found');

    const profile = root.profiles[state.profile];
    if (!profile) throw new Error(`profile not found: ${state.profile}`);
    root.profiles[state.profile] = {
      ...profile,
      accounts: newCfg.accounts,
    };
    if (newCfg.secrets) root.secrets = newCfg.secrets;
    await saveRootConfig(root, state.configPath);
    state.profileConfig = root.profiles[state.profile]!;
    state.cfg = runtimeProfileConfig(root, state.profile);
  });
}

/**
 * Persist preferences + deployment mode + lark-cli identity + require-mention
 * under the config file lock, refreshing in-memory state. Stores the user's
 * identity selection verbatim (not the team-mode-forced effective preset) so
 * it comes back into effect when switching to personal mode.
 */
export async function savePreferencesConfig(
  state: MutableProfileState,
  preferences: AppPreferences,
  requireMentionInGroup: boolean,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
  mode: ProfileMode,
  /** In-meeting agent settings; omitted by callers that don't edit them. */
  meeting?: ProfileConfig['meeting'],
  expectedRevision?: string,
  resetPaths: string[][] = [],
): Promise<void> {
  const updatedLarkCli = {
    identityPreset: larkCliIdentity,
    localUserImport: {
      status: 'not-needed' as const,
      attemptedAt: new Date().toISOString(),
      reason: larkCliIdentity === 'user-default' ? 'manual-user-default' : 'manual-bot-only',
    },
  };
  await withConfigFileLock(state.configPath, async () => {
    if (expectedRevision && configRevision(await readFile(state.configPath, 'utf8')) !== expectedRevision) throw new Error('配置已改变，请重新打开设置');
    const root = await loadRootConfig(state.configPath);
    if (!root) throw new Error('root config not found');

    const profile = root.profiles[state.profile];
    if (!profile) throw new Error(`profile not found: ${state.profile}`);
    const { requireMentionInGroup: _requireMention, access: _access, ...profilePreferences } = preferences;
    const display = { ...larkDisplay(profile) };
    if (preferences.messageReply !== undefined) display.reply_mode = preferences.messageReply;
    if (preferences.showToolCalls !== undefined) display.show_tools = preferences.showToolCalls;
    if (preferences.cotMessages !== undefined) display.progress = preferences.cotMessages === 'on' ? 'detailed' : preferences.cotMessages === 'simple' ? 'brief' : preferences.cotMessages;
    if (preferences.fileLinks !== undefined) display.file_links = preferences.fileLinks;
    const channels = { ...profile.channels, lark: display };
    for (const key of ['messageReply', 'messageReplyMigrated', 'showToolCalls', 'cotMessages', 'fileLinks'] as const) delete profilePreferences[key];
    root.profiles[state.profile] = {
      ...profile,
      mode,
      ...(channels ? { channels } : {}),
      preferences: {
        ...profile.preferences,
        ...profilePreferences,
      },
      access: {
        ...profile.access,
        requireMentionInGroup,
      },
      ...(meeting ? { meeting } : {}),
      larkCli: profile.larkCli.identityPreset === larkCliIdentity ? profile.larkCli : updatedLarkCli,
    };
    await saveRootConfig(root, state.configPath, resetPaths);
    const saved = root.profiles[state.profile]!;
    state.profileConfig = { ...state.profileConfig, preferences: saved.preferences, channels: saved.channels,
      access: saved.access, mode: saved.mode, larkCli: saved.larkCli, ...(meeting ? { meeting: saved.meeting } : {}) };
    state.cfg = { ...state.cfg, ...state.profileConfig };
  });
}
