import { capabilityForProfile } from '../../src/agent/backends';
import type { AgentCapability } from '../../src/agent/capability';
import type { AgentAdapter, AgentBotIdentity } from '../../src/agent/types';
import type { AgentExecutionProfile, AgentKind } from '../../src/config/profile-schema';
import type { ExecutionController } from '../../src/runtime/execution-controller';

/** Serves every scope with one adapter. */
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
