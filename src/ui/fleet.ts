import { resolveAppPaths } from '../config/app-paths';
import {
  getAutostartProfiles,
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
  writeActiveProfile,
} from '../config/profile-store';
import { listAllProfiles } from '../runtime/profile-discovery';
import type { AgentKind } from '../config/profile-schema';
import { HttpError } from './http';
import type { UiSupervisor } from './types';
import { supportsBackgroundProfile } from '../runtime/agent-capabilities';
import { supportsProfileModelService } from '../agent/model-service';

export interface ProfileSummary {
  name: string;
  agentKind: AgentKind;
  active: boolean;
  /** Whether the machine-wide supervisor starts this profile on boot. */
  autostart: boolean;
  /** Whether the supervisor currently hosts this profile's channel. */
  running: boolean;
  capabilities: { backgroundAnalysis: boolean; modelService: boolean };
}

export interface BotSummary {
  id: string;
  profileName: string;
  agentKind: AgentKind;
  botName?: string;
  appId?: string;
  pid: number;
  version: string;
  startedAt?: string;
  uptimeMs: number;
}

/** Online channels the supervisor currently hosts (all under one pid). */
export function listBots(supervisor: UiSupervisor, version: string, now: number): BotSummary[] {
  return supervisor.list().map((s) => ({
    id: s.profile,
    profileName: s.profile,
    agentKind: s.agentKind,
    botName: s.botName,
    appId: s.appId,
    pid: s.pid,
    version,
    startedAt: s.startedAt,
    uptimeMs: s.startedAt ? Math.max(0, now - Date.parse(s.startedAt)) : 0,
  }));
}

/** All profiles with agent kind, active flag, and whether the supervisor hosts them. */
export async function listProfiles(
  supervisor: UiSupervisor,
  rootDir?: string,
): Promise<ProfileSummary[]> {
  const profiles = await listAllProfiles(rootDir).catch(() => []);
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  const autostart = new Set(root ? getAutostartProfiles(root) : []);
  return profiles.map((p) => ({
    name: p.name,
    agentKind: p.agentKind,
    active: p.active,
    autostart: autostart.has(p.name),
    running: supervisor.isOnline(p.name),
    capabilities: {
      backgroundAnalysis: Boolean(root?.profiles[p.name] && supportsBackgroundProfile(root.profiles[p.name]!)),
      modelService: Boolean(root?.profiles[p.name] && root.profiles[p.name]!.mode !== 'team' && supportsProfileModelService(root.profiles[p.name]!)),
    },
  }));
}

/** Change the supervisor boot set without changing the CLI active profile. */
export async function setProfileAutostart(
  name: string,
  enabled: boolean,
  rootDir?: string,
): Promise<{ ok: true; autostart: string[] }> {
  const appPaths = resolveAppPaths({ rootDir });
  return withConfigFileLock(appPaths.configFile, async () => {
    const root = await loadRootConfig(appPaths.configFile);
    if (!root?.profiles[name]) throw new HttpError(404, `profile not found: ${name}`);
    const current = getAutostartProfiles(root);
    root.autostartProfiles = enabled
      ? [...new Set([...current, name])].sort()
      : current.filter(profile => profile !== name);
    await saveRootConfig(root, appPaths.configFile);
    return { ok: true, autostart: root.autostartProfiles };
  });
}

/** Switch the active profile (disk metadata only; does not stop/start channels). */
export async function activateProfile(
  name: string,
  rootDir?: string,
): Promise<{ ok: true; active: string }> {
  const appPaths = resolveAppPaths({ rootDir });
  await withConfigFileLock(appPaths.configFile, async () => {
    const root = await loadRootConfig(appPaths.configFile);
    if (!root?.profiles[name]) throw new HttpError(404, `profile not found: ${name}`);
    root.activeProfile = name;
    await saveRootConfig(root, appPaths.configFile);
  });
  await writeActiveProfile(appPaths.rootDir, name);
  return { ok: true, active: name };
}
