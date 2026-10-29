import type { AgentLaunchProfiles } from './launch-config';
import type { AccessMode } from '../config/permissions';
import type { AgentExecutionProfile, ProfileConfig } from '../config/profile-schema';
import {
  agentBackendSpec,
  type AgentCapabilityId,
  type AgentSessionIdField,
} from './backend-spec';

export type { AgentSessionKind, PromptInjectionMode } from './backend-spec';
export type { AgentCapabilityId };

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: import('./backend-spec').AgentSessionKind;
  /** AgentRunOptions field used to resume this backend. */
  sessionIdField: AgentSessionIdField;
  imageInput: import('./backend-spec').AgentImageInput;
  legacySessionStore: boolean;
  promptInjection: import('./backend-spec').PromptInjectionMode;
  supportsNativeHistory: boolean;
  permissions: {
    maxAccess: AccessMode;
    /** Access modes the backend can actually enforce, when narrower than maxAccess. */
    supportedAccess?: readonly AccessMode[];
  };
}

export function capabilityForBackend(
  kind: AgentCapabilityId,
  profile?: Pick<ProfileConfig, 'permissions'>,
): AgentCapability {
  const spec = agentBackendSpec(kind);
  return {
    agentId: spec.kind,
    sessionKind: spec.sessionKind,
    sessionIdField: spec.sessionIdField,
    imageInput: spec.imageInput,
    legacySessionStore: spec.legacySessionStore,
    promptInjection: spec.promptInjection,
    supportsNativeHistory: spec.supportsNativeHistory,
    permissions: {
      maxAccess: profile?.permissions.maxAccess ?? 'full',
      ...(spec.supportedAccess ? { supportedAccess: spec.supportedAccess } : {}),
    },
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return capabilityForBackend('claude', profile);
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return capabilityForBackend('codex', profile);
}

export function piCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return capabilityForBackend('pi', profile);
}

export function agentLaunchPatch(
  kind: AgentCapabilityId,
  binaryPath: string,
): AgentLaunchProfiles {
  return { [kind]: { binaryPath } } as AgentLaunchProfiles;
}

export function withAgentBinary(
  profile: AgentExecutionProfile,
  kind: AgentCapabilityId,
  binaryPath: string,
): AgentExecutionProfile {
  const current = profile[kind] as unknown as Record<string, unknown> | undefined;
  return {
    ...profile,
    [kind]: { ...current, binaryPath },
  } as AgentExecutionProfile;
}

export function agentStateDirectory(
  profile: AgentLaunchProfiles & { agentKind: AgentCapabilityId },
): string | undefined {
  const spec = agentBackendSpec(profile.agentKind);
  const launch = profile[profile.agentKind] as unknown as Record<string, unknown> | undefined;
  const value = spec.stateDirectory ? launch?.[spec.stateDirectory.field] : undefined;
  return typeof value === 'string' ? value : undefined;
}
