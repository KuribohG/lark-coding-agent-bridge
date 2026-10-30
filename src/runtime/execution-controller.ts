import {
  backendFor,
  capabilityForProfile,
  createAgentAdapter,
} from '../agent/backends';
import type { AgentCapability } from '../agent/capability';
import type { AgentAdapter, AgentBotIdentity } from '../agent/types';
import type { AgentSystemPrompt } from '../agent/system-prompt';
import type {
  AgentExecutionProfile,
  AgentKind,
} from '../config/profile-schema';
import type { ScopeExecutionStore } from '../session/scope-execution';
import { checkRuntimeAgentAvailability } from './agent-runtime';
import {
  ModelProviderRegistry,
  type ResolvedModelProvider,
} from '../model-provider/provider';

export interface ExecutionController {
  readonly defaultAgentKind: AgentKind;
  defaultAgent(): AgentAdapter;
  get(scope: string, agentKind?: AgentKind): AgentAdapter;
  kindFor(scope: string): AgentKind;
  profileFor(scope: string): AgentExecutionProfile;
  capabilityFor(scope: string): AgentCapability;
  resolveModelProvider(agentKind: AgentKind, model?: string): Promise<ResolvedModelProvider | undefined>;
  setBotIdentity(identity: AgentBotIdentity): void;
  setScopeKind(scope: string, kind: AgentKind): Promise<void>;
}

export function profileForAgentKind<T extends AgentExecutionProfile>(
  profileConfig: T,
  agentKind: AgentKind,
): T {
  if (profileConfig.agentKind === agentKind) return profileConfig;
  const backend = backendFor(agentKind);
  const existing = backend.existingProfile(profileConfig);
  if (Object.keys(existing).length > 0) return { ...profileConfig, agentKind, ...existing };
  const command = process.env[backend.commandEnv] ?? backend.defaultCommand;
  return { ...profileConfig, agentKind, ...backend.launchPatch(command) } as T;
}

export interface ProfileExecutionControllerOptions {
  profileConfig: AgentExecutionProfile;
  scopeExecution: ScopeExecutionStore;
  appPaths: Pick<import('../config/app-paths').AppPaths, 'profileDir'> &
    Partial<Pick<
      import('../config/app-paths').AppPaths,
      'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'
    >> & {
      configPath?: string;
    };
  systemPrompt?: AgentSystemPrompt;
  env?: NodeJS.ProcessEnv;
  modelProviders?: ModelProviderRegistry;
}

/** Shared execution routing for Lark and standalone Web conversation channels. */
export class ProfileExecutionController implements ExecutionController {
  private readonly agents = new Map<AgentKind, AgentAdapter>();
  private botIdentity: AgentBotIdentity | undefined;
  private profileConfig: AgentExecutionProfile;

  constructor(private readonly options: ProfileExecutionControllerOptions) {
    this.profileConfig = options.profileConfig;
  }

  get defaultAgentKind(): AgentKind {
    return this.profileConfig.agentKind;
  }

  defaultAgent(): AgentAdapter {
    return this.agentForKind(this.defaultAgentKind);
  }

  get(scope: string, agentKind?: AgentKind): AgentAdapter {
    return this.agentForKind(agentKind ?? this.kindFor(scope));
  }

  kindFor(scope: string): AgentKind {
    return this.options.scopeExecution.get(scope) ?? this.defaultAgentKind;
  }

  profileFor(scope: string): AgentExecutionProfile {
    return profileForAgentKind(this.profileConfig, this.kindFor(scope));
  }

  capabilityFor(scope: string): AgentCapability {
    return capabilityForProfile(this.profileFor(scope));
  }

  async resolveModelProvider(
    agentKind: AgentKind,
    model?: string,
  ): Promise<ResolvedModelProvider | undefined> {
    return this.options.modelProviders?.resolve(agentKind, model, backendFor(agentKind).providerSwitching !== 'startup');
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
    for (const agent of this.agents.values()) agent.setBotIdentity?.(identity);
  }

  async setScopeKind(scope: string, kind: AgentKind): Promise<void> {
    const target = profileForAgentKind(this.profileConfig, kind);
    const capability = capabilityForProfile(target);
    if (
      capability.permissions.supportedAccess &&
      !capability.permissions.supportedAccess.includes(target.permissions.defaultAccess)
    ) {
      throw new Error(
        `${capability.agentId} does not support ${target.permissions.defaultAccess} access`,
      );
    }
    const availability = await checkRuntimeAgentAvailability(this.agentForKind(kind));
    if (!availability.ok) throw availability.error;
    if (kind === this.defaultAgentKind) await this.options.scopeExecution.clear(scope);
    else await this.options.scopeExecution.set(scope, kind);
  }

  private agentForKind(kind: AgentKind): AgentAdapter {
    let agent = this.agents.get(kind);
    if (!agent) {
      const profile = profileForAgentKind(this.profileConfig, kind);
      agent = createAgentAdapter({
        modelProviders: this.options.modelProviders,
        profile,
        profileDir: this.options.appPaths.profileDir,
        env: this.options.env ?? {},
        systemPrompt: this.options.systemPrompt ?? '',
      });
      if (this.botIdentity) agent.setBotIdentity?.(this.botIdentity);
      this.agents.set(kind, agent);
    }
    return agent;
  }
}

/** Compatibility helper for tests and one-engine hosts. */
export class FixedExecutionController implements ExecutionController {
  constructor(
    private readonly agent: AgentAdapter,
    private readonly profileConfig: AgentExecutionProfile,
  ) {}

  get defaultAgentKind(): AgentKind { return this.profileConfig.agentKind; }

  defaultAgent(): AgentAdapter { return this.agent; }
  get(_scope?: string, agentKind?: AgentKind): AgentAdapter {
    if (agentKind && agentKind !== this.defaultAgentKind) throw new Error('fixed execution controller does not support engine overrides');
    return this.agent;
  }
  kindFor(): AgentKind { return this.defaultAgentKind; }
  profileFor(): AgentExecutionProfile { return this.profileConfig; }
  capabilityFor(): AgentCapability { return capabilityForProfile(this.profileConfig); }
  async resolveModelProvider(): Promise<undefined> { return undefined; }
  setBotIdentity(identity: AgentBotIdentity): void { this.agent.setBotIdentity?.(identity); }
  async setScopeKind(): Promise<void> {
    throw new Error('fixed execution controller does not support engine overrides');
  }
}
