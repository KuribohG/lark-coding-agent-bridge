import { buildLarkChannelEnv } from '../agent/lark-channel-env';
import { buildBridgeSystemPrompt } from '../channels/lark/system-prompt';
import {
  backendFor,
  capabilityForProfile,
  createAgentAdapter,
  isAgentKind,
} from '../agent/backends';
import { AgentPreflightError, type AgentAvailability } from '../agent/preflight';
import type { AgentAdapter, AgentBotIdentity } from '../agent/types';
import type { AgentCapability } from '../agent/capability';
import type { AppPaths } from '../config/app-paths';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';
import type { ScopeExecutionStore } from '../session/scope-execution';

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile MUST get its own adapter — the
 * adapter stores bot identity on itself (see `setBotIdentity`).
 */
export function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
      configPath?: string;
    },
): AgentAdapter {
  const larkChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  const larkChannel =
    appPaths.rootDir && appPaths.profile
      ? {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
          ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
          ...(appPaths.larkCliSourceConfigFile
            ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
            : {}),
        }
      : undefined;
  return createAgentAdapter({
    profile: profileConfig,
    profileDir: appPaths.profileDir,
    env: buildLarkChannelEnv(larkChannel),
    systemPrompt: buildBridgeSystemPrompt,
  });
}

export function profileForAgentKind(profileConfig: ProfileConfig, agentKind: AgentKind): ProfileConfig {
  if (profileConfig.agentKind === agentKind) return profileConfig;
  const backend = backendFor(agentKind);
  const existing = agentKind === 'claude'
    ? profileConfig.claude
    : agentKind === 'codex'
      ? profileConfig.codex
      : profileConfig.pi;
  if (existing) return { ...profileConfig, agentKind };
  const command = process.env[backend.commandEnv] ?? backend.defaultCommand;
  return { ...profileConfig, agentKind, ...backend.launchPatch(command) };
}

/**
 * One Feishu-bot profile can route each chat/topic/document scope to a different
 * backend while sharing credentials, locks, permissions and the process pool.
 */
export class RuntimeAgentResolver {
  private readonly agents = new Map<AgentKind, AgentAdapter>();
  private botIdentity: AgentBotIdentity | undefined;

  constructor(
    private profileConfig: ProfileConfig,
    private readonly appPaths: Pick<AppPaths, 'profileDir'> &
      Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
        configPath?: string;
      },
    private readonly scopeExecution: ScopeExecutionStore,
  ) {}

  kindFor(scope: string): AgentKind {
    return this.scopeExecution.get(scope) ?? this.profileConfig.agentKind;
  }

  get(scope: string): AgentAdapter {
    return this.agentForKind(this.kindFor(scope));
  }

  private agentForKind(kind: AgentKind): AgentAdapter {
    let agent = this.agents.get(kind);
    if (!agent) {
      agent = createRuntimeAgent(profileForAgentKind(this.profileConfig, kind), this.appPaths);
      if (this.botIdentity) agent.setBotIdentity?.(this.botIdentity);
      this.agents.set(kind, agent);
    }
    return agent;
  }

  defaultAgent(): AgentAdapter {
    return this.get('');
  }

  capabilityFor(scope: string): AgentCapability {
    return capabilityForProfile(profileForAgentKind(this.profileConfig, this.kindFor(scope)));
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
    for (const agent of this.agents.values()) agent.setBotIdentity?.(identity);
  }

  async setScopeKind(scope: string, kind: AgentKind): Promise<void> {
    const agent = this.agentForKind(kind);
    const availability = await checkRuntimeAgentAvailability(agent);
    if (!availability.ok) throw availability.error;
    if (kind === this.profileConfig.agentKind) await this.scopeExecution.clear(scope);
    else await this.scopeExecution.set(scope, kind);
  }

  reset(profileConfig: ProfileConfig): void {
    this.profileConfig = profileConfig;
    this.agents.clear();
  }
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const backend = backendFor(isAgentKind(agent.id) ? agent.id : 'claude');
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId: backend.kind,
    agentName: agent.displayName,
    command: backend.defaultCommand,
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
