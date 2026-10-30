import { AgyAdapter, AGY_EXECUTION_CAPABILITIES } from './agy/adapter';
import type { AgentLaunchProfiles } from './launch-config';
import { ClaudeAdapter } from './claude/adapter';
import { CLAUDE_EXECUTION_CAPABILITIES } from './claude/capabilities';
import { CodexAdapter } from './codex/adapter';
import { codexExecutionCapabilities } from './codex/capabilities';
import { PiAdapter } from './pi/adapter';
import { PI_EXECUTION_CAPABILITIES } from './pi/capabilities';
import {
  agentLaunchPatch,
  capabilityForBackend,
  type AgentCapability,
} from './capability';
import {
  AGENT_BACKEND_SPECS,
  AGENT_KINDS,
  agentDisplayName,
  isAgentKind,
  type AgentBackendSpec,
} from './backend-spec';
import type { AgentAdapter, AgentExecutionCapabilities } from './types';
import type { AgentSystemPrompt } from './system-prompt';
import type { AgentExecutionProfile, AgentKind } from '../config/profile-schema';
import { accessToCodexSandbox } from '../config/permissions';
import { buildAgentEnvironment } from './launch-env';
import type { ModelProviderRegistry } from '../model-provider/provider';

export interface AgentBackend extends AgentBackendSpec {
  capability(profile: Pick<AgentExecutionProfile, 'agentKind' | 'permissions'>): AgentCapability;
  executionCapabilities(
    profile: Pick<AgentExecutionProfile, 'agentKind' | 'permissions'>,
  ): AgentExecutionCapabilities;
  existingProfile(profile: AgentExecutionProfile): Partial<AgentExecutionProfile>;
  launchPatch(binaryPath: string): AgentLaunchProfiles;
  createAdapter(input: CreateAgentAdapterInput): AgentAdapter;
}

export interface CreateAgentAdapterInput {
  modelProviders?: ModelProviderRegistry;
  profile: AgentExecutionProfile & { preferences?: { model?: string } };
  profileDir: string;
  env: NodeJS.ProcessEnv;
  systemPrompt: AgentSystemPrompt;
}

const IMPLEMENTATIONS: Record<AgentKind, Pick<AgentBackend, 'executionCapabilities' | 'createAdapter'>> = {
  agy: {
    executionCapabilities: () => AGY_EXECUTION_CAPABILITIES,
    createAdapter: ({ profile, env, systemPrompt }) => new AgyAdapter({
      binary: profile.agy?.binaryPath,
      env: buildAgentEnvironment(env, profile.agy?.env),
      systemPrompt,
    }),
  },
  claude: {
    executionCapabilities: () => CLAUDE_EXECUTION_CAPABILITIES,
    createAdapter: ({ profile, env, systemPrompt }) => new ClaudeAdapter({
      binary: profile.claude?.binaryPath,
      configDir: profile.claude?.configDir,
      env: buildAgentEnvironment(env, profile.claude?.env),
      systemPrompt,
    }),
  },
  codex: {
    executionCapabilities: () => codexExecutionCapabilities(),
    createAdapter: ({ profile, profileDir, env, systemPrompt, modelProviders }) => {
      const codex = profile.codex;
      if (!codex?.binaryPath) throw new Error('codex profile requires codex.binaryPath');
      return new CodexAdapter({
        binary: codex.binaryPath,
        systemPrompt,
        transport: codex.transport,
        appServerMode: codex.appServerMode,
        startupProvider: () => modelProviders?.resolveStartup('codex', profile.preferences?.model, codex.provider),
        profileStateDir: profileDir,
        ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
        inheritCodexHome: codex.inheritCodexHome === true,
        ignoreUserConfig: codex.ignoreUserConfig === true,
        ignoreRules: codex.ignoreRules,
        sandbox: profile.sandbox?.defaultMode ?? accessToCodexSandbox(profile.permissions.defaultAccess),
        env: buildAgentEnvironment(env, codex.env),
      });
    },
  },
  pi: {
    executionCapabilities: () => PI_EXECUTION_CAPABILITIES,
    createAdapter: ({ profile, profileDir, env, systemPrompt }) => {
      const pi = profile.pi;
      if (!pi?.binaryPath) throw new Error('pi profile requires pi.binaryPath');
      return new PiAdapter({
        binary: pi.binaryPath,
        agentDir: pi.agentDir,
        profileStateDir: profileDir,
        env: buildAgentEnvironment(env, pi.env),
        systemPrompt,
      });
    },
  },
};

const BACKENDS = Object.fromEntries(AGENT_KINDS.map((kind): [AgentKind, AgentBackend] => [kind, {
  ...AGENT_BACKEND_SPECS[kind],
  ...IMPLEMENTATIONS[kind],
  capability: (profile: Pick<AgentExecutionProfile, 'permissions'>) => capabilityForBackend(kind, profile),
  existingProfile: (profile: AgentExecutionProfile) => profile[kind] ? { [kind]: profile[kind] } : {},
  launchPatch: (binaryPath: string) => agentLaunchPatch(kind, binaryPath),
}])) as Record<AgentKind, AgentBackend>;

export { AGENT_KINDS };
export const AGENT_OPTIONS = Object.freeze(AGENT_KINDS.map((kind) => ({
  value: kind,
  label: BACKENDS[kind].displayName,
})));

export function backendFor(kind: AgentKind): AgentBackend {
  return BACKENDS[kind];
}

export { agentDisplayName, isAgentKind };

export function capabilityForProfile(
  profile: Pick<AgentExecutionProfile, 'agentKind' | 'permissions'>,
): AgentCapability {
  return backendFor(profile.agentKind).capability(profile);
}

export function executionCapabilitiesForProfile(
  profile: Pick<AgentExecutionProfile, 'agentKind' | 'permissions'>,
): AgentExecutionCapabilities {
  return backendFor(profile.agentKind).executionCapabilities(profile);
}

export function detectedAgentCandidates(): Array<{
  kind: AgentKind;
  command: string;
}> {
  return AGENT_KINDS.map((kind) => {
    const backend = backendFor(kind);
    return {
      kind,
      command: process.env[backend.commandEnv] ?? backend.defaultCommand,
    };
  });
}

export function createAgentAdapter(input: CreateAgentAdapterInput): AgentAdapter {
  return backendFor(input.profile.agentKind).createAdapter(input);
}
