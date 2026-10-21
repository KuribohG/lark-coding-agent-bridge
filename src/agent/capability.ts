import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';

export type AgentCapabilityId = 'claude' | 'codex' | 'pi';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'pi-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  /** AgentRunOptions field used to resume this backend. */
  sessionIdField: 'sessionId' | 'threadId';
  imageInput: 'paths' | 'attachments';
  legacySessionStore: boolean;
  promptInjection: PromptInjectionMode;
  supportsNativeHistory: boolean;
  permissions: {
    maxAccess: AccessMode;
    /** Access modes the backend can actually enforce, when narrower than maxAccess. */
    supportedAccess?: readonly AccessMode[];
  };
}
export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    sessionIdField: 'sessionId',
    imageInput: 'attachments',
    legacySessionStore: true,
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
    sessionIdField: 'threadId',
    imageInput: 'paths',
    legacySessionStore: false,
    promptInjection: 'stdin-prefix',
    supportsNativeHistory: false,
    permissions: { maxAccess },
  };
}

export function piCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    agentId: 'pi',
    sessionKind: 'pi-session',
    sessionIdField: 'sessionId',
    imageInput: 'attachments',
    legacySessionStore: false,
    promptInjection: 'append-system-prompt',
    supportsNativeHistory: true,
    permissions: {
      maxAccess: profile.permissions.maxAccess,
      // Pi has no portable filesystem sandbox. Read-only is enforced by an
      // explicit built-in tool allowlist; full access inherits Pi's tools.
      supportedAccess: ['read-only', 'full'],
    },
  };
}

export function sessionIdFieldForAgent(
  agentId: AgentCapabilityId,
): AgentCapability['sessionIdField'] {
  return agentId === 'codex' ? 'threadId' : 'sessionId';
}
