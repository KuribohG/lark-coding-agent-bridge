import { startLarkChannel, type BridgeChannel, type StartChannelDeps } from './channel';
import type { ChannelPlugin } from '../plugin';
import type { AgentAdapter, AgentBotIdentity } from '../../agent/types';
import type { AgentKind } from '../../config/profile-schema';
import { capabilityForProfile } from '../../agent/backends';
import {
  profileForAgentKind,
  type ExecutionController,
} from '../../runtime/execution-controller';

export { createLarkRunOutput } from './run-output';
export type { LarkRunOutputOptions } from './run-output';
export interface LarkConnection extends BridgeChannel { close(): Promise<void> }

export type LegacyLarkStartChannelDeps = Omit<StartChannelDeps, 'execution'> & {
  agent: AgentAdapter;
  resolveAgent?: (scope: string) => AgentAdapter;
  resolveAgentKind?: (scope: string) => AgentKind;
  setAgentKind?: (scope: string, kind: AgentKind) => Promise<void>;
  setAgentIdentity?: (identity: AgentBotIdentity) => void;
};

export type LarkStartChannelEntryDeps = StartChannelDeps | LegacyLarkStartChannelDeps;

function normalizeExecutionDeps(deps: LarkStartChannelEntryDeps): StartChannelDeps {
  if ('execution' in deps && deps.execution) return deps;
  if (!('agent' in deps) || !deps.agent) throw new Error('Lark channel requires execution or agent');
  const { agent, resolveAgent, resolveAgentKind, setAgentKind, setAgentIdentity, ...rest } = deps;
  const kindFor = (scope: string) => resolveAgentKind?.(scope) ?? rest.controls.profileConfig.agentKind;
  const execution: ExecutionController = {
    defaultAgentKind: rest.controls.profileConfig.agentKind,
    defaultAgent: () => agent,
    get: scope => resolveAgent?.(scope) ?? agent,
    kindFor,
    profileFor: scope => profileForAgentKind(rest.controls.profileConfig, kindFor(scope)),
    capabilityFor: scope => capabilityForProfile(profileForAgentKind(rest.controls.profileConfig, kindFor(scope))),
    setBotIdentity(identity) {
      setAgentIdentity?.(identity);
      agent.setBotIdentity?.(identity);
    },
    async setScopeKind(scope, kind) {
      if (!setAgentKind) throw new Error('fixed execution controller does not support engine overrides');
      await setAgentKind(scope, kind);
    },
  };
  return { ...rest, execution };
}

export function createLarkPlugin(deps: LarkStartChannelEntryDeps): ChannelPlugin<LarkConnection> {
  const normalized = normalizeExecutionDeps(deps);
  return {
    id: `lark:${normalized.controls.profile}`,
    async connect() {
      const bridge = await startLarkChannel(normalized);
      return { ...bridge, close: () => bridge.disconnect() };
    },
  };
}
