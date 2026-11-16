import { log } from '../../core/logger';
import type { AgentExecutionProfile } from '../../config/profile-schema';
import { buildExecSandboxCommand, type ExecSandboxSettings } from '../../platform/exec-sandbox';
import { agentStateRoots, resolveAgentState } from '../state-layout';

/**
 * The profile-scoped exec sandbox of a shared Pi SDK host.
 *
 * `pi.transport = "sdk"` serves every session from one long-lived process, and a
 * Landlock domain cannot be widened or lifted once applied, so the host gets one
 * static domain instead of one per run. The domain is the provider's whole
 * runtime: harness state, bridge workspaces, agent homes, caches and whatever
 * the profile lists in `exec_sandbox.read_write`. A run's own cwd is therefore
 * not added automatically — a write outside this list is denied by the kernel.
 */
export interface PiHostSandbox {
  settings: ExecSandboxSettings;
  /** Profile-scoped writable roots, on top of the platform defaults. */
  roots: readonly string[];
  /** Test seam: override the compiled launcher. */
  launcher?: string;
}

/**
 * Domain of a shared SDK host: one static Landlock ruleset for the whole
 * profile, because the host serves every session from one process. Bridge
 * workspaces and agent homes are writable; a run's own cwd only if the profile
 * lists it in `exec_sandbox.read_write`.
 */
export function piSdkSandbox(
  profile: Pick<AgentExecutionProfile, 'agentKind' | 'state' | 'execSandbox'>,
  context: { profileDir: string; env: NodeJS.ProcessEnv },
): PiHostSandbox {
  const roots = agentStateRoots(profile.state);
  const layout = resolveAgentState(profile, 'pi', context);
  return {
    settings: profile.execSandbox!,
    roots: [...Object.values(roots), ...(layout.defaultWorkspace ? [layout.defaultWorkspace] : [])],
  };
}

export interface PiHostSpawnCommand {
  command: string;
  args: string[];
  sandboxed: boolean;
}

/** Wrap the host command line in the Landlock launcher when the profile asks for it. */
export function piHostSpawnCommand(
  nodePath: string,
  args: readonly string[],
  sandbox: PiHostSandbox | undefined,
  env: NodeJS.ProcessEnv,
): PiHostSpawnCommand {
  if (!sandbox?.settings.enabled) return { command: nodePath, args: [...args], sandboxed: false };
  const command = buildExecSandboxCommand(nodePath, args, {
    settings: sandbox.settings,
    env,
    agent: 'pi',
    roots: sandbox.roots,
    ...(sandbox.launcher ? { launcher: sandbox.launcher } : {}),
  });
  if (!command.sandboxed) {
    log.warn('agent', 'pi-sdk-host-sandbox-unavailable', {
      requireLandlock: sandbox.settings.requireLandlock,
    });
  }
  return { command: command.command, args: command.args, sandboxed: command.sandboxed };
}
