import { mkdir } from 'node:fs/promises';
import { AgentPreflightError } from '../agent/preflight';
import { agentBackendSpec } from '../agent/backend-spec';
import { agentLaunchPatch } from '../agent/capability';
import type { AgentLaunchProfiles } from '../agent/launch-config';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig, type ProfileMode } from '../config/profile-schema';
import type { PermissionConfig } from '../config/permissions';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { resolveExecutablePath } from '../agent/detection';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  binaryPath?: string;
  /** Extra environment for the agent process, e.g. a third-party gateway endpoint and token. */
  launchEnv?: Record<string, string>;
  permissions?: Partial<PermissionConfig>;
  mode?: ProfileMode;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  // The managed default is derived from the bridge-wide layout; only an explicit workspace is persisted.
  const workspace = input.workspace ? await resolveBootstrapWorkspace(input.workspace) : undefined;
  if (!workspace && input.defaultWorkspace) await mkdir(input.defaultWorkspace, { recursive: true, mode: 0o700 });
  const spec = agentBackendSpec(input.agentKind);
  // Backends that default to PATH lookup still honour an explicitly chosen executable.
  const launch = spec.launchRequired || input.binaryPath
    ? await createBootstrapBinaryConfig({
        binaryPath: input.binaryPath,
        envName: spec.commandEnv,
        fallback: spec.defaultCommand,
        agentId: spec.kind,
        agentName: spec.displayName,
      })
    : undefined;
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(launch ? withLaunchEnv(agentLaunchPatch(input.agentKind, launch.binaryPath), input.agentKind, input.launchEnv) : {}),
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  return profile;
}

function withLaunchEnv(patch: AgentLaunchProfiles, kind: AgentKind, env: Record<string, string> | undefined): AgentLaunchProfiles {
  if (!env || !Object.keys(env).length) return patch;
  return { ...patch, [kind]: { ...patch[kind], env } } as AgentLaunchProfiles;
}

async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function createBootstrapBinaryConfig(input: {
  binaryPath?: string;
  envName: string;
  fallback: string;
  agentId: AgentKind;
  agentName: string;
}) {
  const command = input.binaryPath ?? process.env[input.envName] ?? input.fallback;
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: bootstrapBinaryErrorCode(errno),
      agentId: input.agentId,
      agentName: input.agentName,
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

function bootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}
