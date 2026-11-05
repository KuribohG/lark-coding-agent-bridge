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
  const switched = withoutProfileWorkspace(profileConfig);
  if (Object.keys(existing).length > 0) return { ...switched, agentKind, ...existing };
  const command = process.env[backend.commandEnv] ?? backend.defaultCommand;
  return { ...switched, agentKind, ...backend.launchPatch(command) } as T;
}

/** A profile's own default workspace belongs to its configured engine; a switched engine uses the bridge-wide layout. */
function withoutProfileWorkspace<T extends AgentExecutionProfile>(profileConfig: T): T {
  const workspaces = (profileConfig as T & { workspaces?: { default?: string } }).workspaces;
  if (!workspaces?.default) return profileConfig;
  const { default: _, ...rest } = workspaces;
  return { ...profileConfig, workspaces: rest };
}

export interface ProfileExecutionControllerOptions {
  profileConfig: AgentExecutionProfile;
  /** Only standalone Web supports per-conversation engine choices. */
  scopeExecution?: ScopeExecutionStore;
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
  private modelProviders: ModelProviderRegistry | undefined;

  constructor(private readonly options: ProfileExecutionControllerOptions) {
    this.profileConfig = options.profileConfig;
    this.modelProviders = options.modelProviders;
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
    return this.options.scopeExecution?.get(scope) ?? this.defaultAgentKind;
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
    return this.modelProviders?.resolve(agentKind, model, backendFor(agentKind).providerSwitching !== 'startup');
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
    for (const agent of this.agents.values()) agent.setBotIdentity?.(identity);
  }

  /** Publish a default for future runs without replacing active adapters. */
  async setDefaultProfile(profile: AgentExecutionProfile): Promise<void> {
    const agent = this.createAgent(profile);
    await this.checkAvailability(profile, agent);
    this.agents.set(profile.agentKind, agent);
    this.profileConfig = profile;
  }

  /**
   * Make-before-break swap of launch, permission and provider settings: the
   * new default adapter must pass the availability check before it replaces
   * anything. Active runs keep the adapter they started with; adapters for
   * other engines are rebuilt lazily from the new profile.
   */
  async reconfigure(profile: AgentExecutionProfile, modelProviders = this.modelProviders): Promise<void> {
    const agent = this.createAgent(profile, modelProviders);
    await this.checkAvailability(profile, agent);
    const providersChanged = JSON.stringify(this.modelProviders?.services ?? {}) !== JSON.stringify(modelProviders?.services ?? {});
    const blocker = await this.agents.get(profile.agentKind)?.replacementBlocker?.(agent, { providersChanged });
    if (blocker) throw new ReconfigureDeferred(blocker);
    // Other engines' adapters survive when nothing they were built from changed.
    const kept = [...this.agents].filter(([kind]) => kind !== profile.agentKind && sameLaunch(
      profileForAgentKind(this.profileConfig, kind), profileForAgentKind(profile, kind),
    ) && !providersChanged);
    this.agents.clear();
    for (const [kind, adapter] of kept) this.agents.set(kind, adapter);
    this.agents.set(profile.agentKind, agent);
    this.profileConfig = profile;
    this.modelProviders = modelProviders;
  }

  /** Refresh per-run settings (model, workspaces) that adapters do not capture. */
  updateProfile(profile: AgentExecutionProfile): void {
    this.profileConfig = profile;
  }

  async setScopeKind(scope: string, kind: AgentKind): Promise<void> {
    if (!this.options.scopeExecution) throw new Error('This host uses a bot-wide execution engine');
    const target = profileForAgentKind(this.profileConfig, kind);
    await this.checkAvailability(target, this.agentForKind(kind));
    if (kind === this.defaultAgentKind) await this.options.scopeExecution.clear(scope);
    else await this.options.scopeExecution.set(scope, kind);
  }

  private async checkAvailability(profile: AgentExecutionProfile, agent: AgentAdapter): Promise<void> {
    const capability = capabilityForProfile(profile);
    if (capability.permissions.supportedAccess &&
        !capability.permissions.supportedAccess.includes(profile.permissions.defaultAccess)) {
      throw new Error(`${capability.agentId} does not support ${profile.permissions.defaultAccess} access`);
    }
    const availability = await checkRuntimeAgentAvailability(agent);
    if (!availability.ok) throw availability.error;
  }

  private agentForKind(kind: AgentKind): AgentAdapter {
    let agent = this.agents.get(kind);
    if (!agent) {
      const profile = profileForAgentKind(this.profileConfig, kind);
      agent = this.createAgent(profile);
      this.agents.set(kind, agent);
    }
    return agent;
  }

  private createAgent(profile: AgentExecutionProfile, modelProviders = this.modelProviders): AgentAdapter {
    const agent = createAgentAdapter({
      modelProviders,
      profile,
      currentModel: () => preferredModel(this.profileConfig.agentKind === profile.agentKind ? this.profileConfig : profile),
      profileDir: this.options.appPaths.profileDir,
      env: this.options.env ?? {},
      systemPrompt: this.options.systemPrompt ?? '',
    });
    if (this.botIdentity) agent.setBotIdentity?.(this.botIdentity);
    return agent;
  }
}

/** The new configuration is valid but would disrupt active runs; retry once they finish. */
export class ReconfigureDeferred extends Error {
  readonly deferred = true;
  constructor(message: string) { super(message); this.name = 'ReconfigureDeferred'; }
}

function sameLaunch(a: AgentExecutionProfile, b: AgentExecutionProfile): boolean {
  // An absent launch block means the backend's default command.
  const launch = (p: AgentExecutionProfile) => {
    const backend = backendFor(p.agentKind);
    return p[p.agentKind] ?? backend.launchPatch(process.env[backend.commandEnv] ?? backend.defaultCommand)[p.agentKind];
  };
  const pick = (p: AgentExecutionProfile) => JSON.stringify([p.agentKind, launch(p), p.permissions, p.state]);
  return pick(a) === pick(b);
}

function preferredModel(profile: AgentExecutionProfile): string | undefined {
  return (profile as AgentExecutionProfile & { preferences?: { model?: string } }).preferences?.model;
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
