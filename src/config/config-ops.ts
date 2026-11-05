import type { AgentLaunchProfiles } from '../agent/launch-config';
import { readFile } from 'node:fs/promises';
import { configRevision } from './profile-store';
import { larkDisplay } from './lark-display';
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
import type { ProfileAccess, ProfileConfig, ProfileMode, RootConfig } from './profile-schema';
import { applyLarkCliIdentityPolicy } from '../lark-cli/identity-policy';
import { log, reportMetric } from '../core/logger';

/**
 * The per-profile state these ops read and keep in sync. The running bridge's
 * `Controls` object structurally satisfies this, so the chat `/config`
 * handlers and the local web UI's REST layer share one write path.
 *
 * Writers only write the file. A running profile then reconciles through
 * `applyConfig` — the same path as file-watch and `/config reload` — so a
 * save can never half-apply settings that need a component rebuild. Disk-backed
 * views of offline profiles simply mirror the saved file.
 */
export interface MutableProfileState {
  configPath: string;
  profile: string;
  cfg: AppConfig;
  profileConfig: ProfileConfig;
  applyConfig?(trigger: 'save'): Promise<unknown>;
}

async function publishSaved(state: MutableProfileState, root: RootConfig): Promise<void> {
  if (state.applyConfig) {
    await state.applyConfig('save');
    return;
  }
  state.profileConfig = root.profiles[state.profile]!;
  state.cfg = runtimeProfileConfig(root, state.profile);
}

/** App paths for a profile, derived from its config path. */
function profileAppPaths(state: Pick<MutableProfileState, 'configPath' | 'profile'>) {
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
    const { root, access } = await withConfigFileLock(state.configPath, async () => {
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
      log.info('config-ops', 'access-mutated', {
        allowedUsers: access.allowedUsers.length,
        allowedChats: access.allowedChats.length,
        admins: access.admins.length,
      });
      return { root, access };
    });
    await publishSaved(state, root);
    return access;
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

  const root = await withConfigFileLock(state.configPath, async () => {
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
    return root;
  });
  // Credentials are reconnect-class: a running profile reports them pending
  // until the caller's reconnect applies them.
  await publishSaved(state, root);
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
  agentSwitch?: {
    agentKind: ProfileConfig['agentKind'];
    launchPatch: AgentLaunchProfiles;
  },
): Promise<void> {
  const updatedLarkCli = {
    identityPreset: larkCliIdentity,
    localUserImport: {
      status: 'not-needed' as const,
      attemptedAt: new Date().toISOString(),
      reason: larkCliIdentity === 'user-default' ? 'manual-user-default' : 'manual-bot-only',
    },
  };
  const saved = await withConfigFileLock(state.configPath, async () => {
    if (expectedRevision && configRevision(await readFile(state.configPath, 'utf8')) !== expectedRevision) throw new Error('配置已改变，请重新打开设置');
    const root = await loadRootConfig(state.configPath);
    if (!root) throw new Error('root config not found');

    const profile = root.profiles[state.profile];
    if (!profile) throw new Error(`profile not found: ${state.profile}`);
    const { requireMentionInGroup: _requireMention, access: _access, ...profilePreferences } = preferences;
    const display = { ...larkDisplay(profile) };
    if (preferences.messageReply !== undefined) display.reply_mode = preferences.messageReply;
    if (preferences.showToolCalls !== undefined) display.show_tools = preferences.showToolCalls;
    if (preferences.cotMessages !== undefined) display.progress = preferences.cotMessages;
    if (preferences.fileLinks !== undefined) display.file_links = preferences.fileLinks;
    const channels = { ...profile.channels, lark: display };
    for (const key of ['messageReply', 'showToolCalls', 'cotMessages', 'fileLinks'] as const) delete profilePreferences[key];
    root.profiles[state.profile] = {
      ...profile,
      ...(agentSwitch ? { agentKind: agentSwitch.agentKind, ...agentSwitch.launchPatch } : {}),
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
    return root;
  });
  // An engine switch is published by the caller's switchAgent, which reports
  // availability failures; everything else reconciles here.
  if (!agentSwitch || !state.applyConfig) await publishSaved(state, saved);
}
