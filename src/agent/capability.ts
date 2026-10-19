import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';

export type AgentCapabilityId = 'claude' | 'codex';
export type AgentSessionKind = 'claude-session' | 'codex-thread';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  supportsNativeHistory: boolean;
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    supportsNativeHistory: true,
    permissions: { maxAccess },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    supportsNativeHistory: false,
    permissions: { maxAccess },
  };
}
