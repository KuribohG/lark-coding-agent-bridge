import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentPreflightError } from '../agent/preflight';
import { agentBackendSpec } from '../agent/backend-spec';
import { agentLaunchPatch } from '../agent/capability';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { resolveExecutablePath } from './agent-detection';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  codexBinaryPath?: string;
  piBinaryPath?: string;
  profileDir?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  const spec = agentBackendSpec(input.agentKind);
  const requestedBinary = input.agentKind === 'codex'
    ? input.codexBinaryPath
    : input.agentKind === 'pi'
      ? input.piBinaryPath
      : undefined;
  const launch = spec.launchRequired
    ? await createBootstrapBinaryConfig({
        binaryPath: requestedBinary,
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
    ...(launch ? agentLaunchPatch(input.agentKind, launch.binaryPath) : {}),
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  if (input.profileDir && profile.codex?.inheritCodexHome === false) {
    await mkdir(join(input.profileDir, 'codex-home'), { recursive: true });
  }
  return profile;
}

async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
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
