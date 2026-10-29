import { AGENT_KINDS } from '../../agent/backend-spec';
import {
  resolveExecutionProfile,
  resolveRun,
  type ConfigDocument,
} from '../../config/document';
import { isAgentKind } from '../../agent/backends';
import { agentBackendSpec } from '../../agent/backend-spec';
import { withAgentBinary } from '../../agent/capability';
import type {
  AgentKind,
  RunProfileConfig,
} from '../../config/profile-schema';

export interface StandaloneProfileOverrides {
  binary?: string;
  model?: string;
}

export function selectStandaloneProfile(
  doc: ConfigDocument | undefined,
  requested?: string,
): string | undefined {
  if (!doc) {
    if (requested) throw new Error('--profile requires --config');
    return undefined;
  }
  const profile = requested ?? doc.bridge?.active_profile ?? Object.keys(doc.profiles)[0];
  if (profile && !doc.profiles[profile]) throw new Error(`profile not found: ${profile}`);
  return profile;
}

export function selectStandaloneAgent(
  doc: ConfigDocument | undefined,
  profile: string | undefined,
  requested: string | undefined,
): AgentKind {
  if (requested !== undefined) {
    if (!isAgentKind(requested)) throw new Error(`agent must be ${AGENT_KINDS.join(', ')}`);
    return requested;
  }
  const selected = profile ? doc?.profiles[profile]?.agent : undefined;
  if (typeof selected === 'string' && isAgentKind(selected)) return selected;
  const first = doc ? Object.values(doc.profiles).find(entry => isAgentKind(entry.agent))?.agent : undefined;
  return typeof first === 'string' && isAgentKind(first) ? first : 'claude';
}

export function standaloneProfile(
  doc: ConfigDocument | undefined,
  profile: string | undefined,
  agentKind: AgentKind,
  workspace: string,
  options: StandaloneProfileOverrides,
  initialAgentKind: AgentKind = agentKind,
): RunProfileConfig {
  const fallbackAccess = agentBackendSpec(agentKind).webDefaultAccess;
  const fallbackPermissions = {
    defaultAccess: fallbackAccess,
    maxAccess: fallbackAccess,
  };
  const execution = resolveExecutionProfile(doc ?? { version: 3, profiles: {} }, agentKind, {
    profile,
    fallbackPermissions,
  });
  const withBinary = options.binary && agentKind === initialAgentKind
    ? withAgentBinary(execution, agentKind, options.binary)
    : execution;
  const profileLayer = profile && doc?.profiles[profile]?.agent === agentKind ? profile : undefined;
  const preferences = {
    maxConcurrentRuns: 4,
    ...(doc ? resolveRun(doc, agentKind, profileLayer).preferences : {}),
    ...(options.model && agentKind === initialAgentKind ? { model: options.model } : {}),
  };
  return {
    ...withBinary,
    preferences,
    workspaces: { default: workspace },
    access: { allowedUsers: [], allowedChats: [], admins: [], requireMentionInGroup: false },
    attachments: { maxCount: 0, maxBytes: 0, maxFileBytes: 0, imageMaxBytes: 0, cacheTtlMs: 0, cacheMaxBytes: 0 },
  };
}
